import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { AmazonHttpService } from './amazon-http.service';
import { AmazonParserHelpers as H } from './amazon-parser.helpers';
import { AmazonReviewParserService } from './amazon-review-parser.service';
import {
  JsonValue,
  ParsedProduct,
  ParsedSeller,
  ProductLink,
  SellerType,
} from './parser.types';

@Injectable()
export class AmazonProductParserService {
  constructor(
    private readonly http: AmazonHttpService,
    private readonly reviewParser: AmazonReviewParserService,
  ) {}

  async parseProduct(seed: ProductLink): Promise<ParsedProduct> {
    const productHtml = await this.http.getHtml(seed.url, seed.sourceUrl);
    const $ = cheerio.load(productHtml);
    const productJsonLd = this.extractProductJsonLd($);

    const canonicalUrl =
      H.firstNonEmpty(
        $('link[rel="canonical"]').attr('href'),
        $('meta[property="og:url"]').attr('content'),
        H.getJsonLdString(productJsonLd?.url),
        seed.url,
      ) ?? seed.url;

    const asin =
      H.extractAsinFromUrl(canonicalUrl) ??
      H.extractAsinFromUrl(seed.url) ??
      seed.asin;

    const title =
      H.firstNonEmpty(
        $('#productTitle').text(),
        $('#title').text(),
        $('#ebooksProductTitle').text(),
        $('h1').first().text(),
        H.getJsonLdString(productJsonLd?.name),
        seed.title,
      ) ?? seed.asin;

    const breadcrumbs = H.dedupeStrings(
      $('#wayfinding-breadcrumbs_feature_div ul li')
        .map((_, el) => H.clean($(el).text()))
        .get(),
    ).filter((item) => item !== '›');

    const bylineText =
      H.firstNonEmpty(
        $('#bylineInfo').text(),
        $('#bylineInfo_feature_div').text(),
      ) ?? null;

    const merchantText =
      H.firstNonEmpty(
        $('#sellerProfileTriggerId').text(),
        $('#merchantInfo a').first().text(),
        $('#merchantInfo').text(),
        $('#tabular-buybox-container .tabular-buybox-text').text(),
        $('#tabular-buybox .tabular-buybox-text').text(),
      ) ?? null;

    const isBook = this.isBookProduct(breadcrumbs, bylineText);

    const authorSeller = this.extractAuthorSeller(
      $,
      productJsonLd,
      canonicalUrl,
      bylineText,
    );

    const merchantSeller = this.extractMerchantSeller(
      $,
      canonicalUrl,
      merchantText,
    );

    const seller = isBook
      ? (authorSeller ?? merchantSeller)
      : (merchantSeller ?? authorSeller);

    const pricing = this.extractPricing($, productJsonLd);
    const variationTheme = this.extractVariationTheme(productHtml, $);
    const variationAsins = this.extractVariationAsins($, asin);
    const hasVariations = Boolean(variationTheme) || variationAsins.length > 1;
    const groupId = this.buildGroupId(asin, variationAsins);

    const avgRatingText =
      H.firstNonEmpty(
        $('#acrPopover').attr('title'),
        $('[data-hook="rating-out-of-text"]').first().text(),
        $('.reviewCountTextLinkedHistogram').first().attr('title'),
      ) ?? null;

    const reviewsCountText =
      H.firstNonEmpty(
        $('#acrCustomerReviewText').text(),
        $('[data-hook="total-review-count"]').first().text(),
        $('#reviews-medley-footer .a-link-emphasis').first().text(),
      ) ?? null;

    const availabilityText =
      H.firstNonEmpty(
        $('#availability span').text(),
        $('#availability').text(),
      ) ?? null;

    const media = this.extractMedia($, productJsonLd);

    const reviews = await this.reviewParser.parseReviews(
      asin,
      groupId,
      variationAsins,
      seed.url,
      seed.sourceUrl,
      productHtml,
    );

    return {
      asin,
      canonicalUrl,
      groupId,
      variationAsins,
      title,
      seller,
      variationTheme,
      hasVariations,

      priceAmount: pricing.priceAmount,
      listPriceAmount: pricing.listPriceAmount,
      priceMinAmount: pricing.priceMinAmount,
      priceMaxAmount: pricing.priceMaxAmount,
      couponAmount: pricing.couponAmount,
      currencyCode: pricing.currencyCode,

      avgRating: H.parseRating(avgRatingText) ?? pricing.jsonLdRating,
      reviewsCount:
        H.parseInteger(reviewsCountText) ?? pricing.jsonLdReviewCount,
      availabilityStatus:
        H.toAvailabilityStatus(availabilityText) !== 'UNKNOWN'
          ? H.toAvailabilityStatus(availabilityText)
          : pricing.jsonLdAvailability,

      breadcrumbs,
      media,
      reviews,
    };
  }

  private extractProductJsonLd(
    $: cheerio.CheerioAPI,
  ): Record<string, any> | null {
    const scripts = $('script[type="application/ld+json"]')
      .map((_, el) => $(el).html() ?? '')
      .get()
      .filter(Boolean);

    for (const script of scripts) {
      const parsed = H.safeJsonParse(script);
      const productNode = this.findFirstProductNode(parsed);
      if (productNode) {
        return productNode;
      }
    }

    return null;
  }

  private findFirstProductNode(value: JsonValue): Record<string, any> | null {
    if (!value) return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findFirstProductNode(item);
        if (found) return found;
      }
      return null;
    }

    if (typeof value !== 'object') {
      return null;
    }

    const typedValue = value as Record<string, any>;
    const type = typedValue['@type'];

    if (
      (typeof type === 'string' && type.toLowerCase() === 'product') ||
      (Array.isArray(type) &&
        type.some((item) => String(item).toLowerCase() === 'product'))
    ) {
      return typedValue;
    }

    if (typedValue['@graph']) {
      const foundInGraph = this.findFirstProductNode(typedValue['@graph']);
      if (foundInGraph) return foundInGraph;
    }

    for (const child of Object.values(typedValue)) {
      const found = this.findFirstProductNode(child as JsonValue);
      if (found) return found;
    }

    return null;
  }

  private extractOfferField(
    productJsonLd: Record<string, any> | null,
    key: string,
  ): JsonValue {
    if (!productJsonLd?.offers) return null;

    const offers = productJsonLd.offers;

    if (Array.isArray(offers)) {
      for (const offer of offers) {
        if (offer && typeof offer === 'object' && offer[key] != null) {
          return offer[key] as JsonValue;
        }
      }

      return null;
    }

    if (typeof offers === 'object' && offers[key] != null) {
      return offers[key] as JsonValue;
    }

    return null;
  }

  private extractPricing(
    $: cheerio.CheerioAPI,
    productJsonLd: Record<string, any> | null,
  ): {
    priceAmount: number | null;
    listPriceAmount: number | null;
    priceMinAmount: number | null;
    priceMaxAmount: number | null;
    couponAmount: number | null;
    couponText: string | null;
    couponPercent: number | null;
    currencyCode: string | null;
    jsonLdRating: number | null;
    jsonLdReviewCount: number | null;
    jsonLdAvailability: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
  } {
    const priceText =
      H.firstNonEmpty(
        $('#corePrice_feature_div .a-offscreen').first().text(),
        $('.priceToPay .a-offscreen').first().text(),
        $('#tp_price_block_total_price_ww .a-offscreen').first().text(),
        $('.a-price.aok-align-center .a-offscreen').first().text(),
        $('.a-price .a-offscreen').first().text(),
        $('#kindle-price .a-color-price').first().text(),
      ) ?? null;

    const listPriceText =
      H.firstNonEmpty(
        $('#corePrice_feature_div .basisPrice .a-offscreen').first().text(),
        $('#corePrice_feature_div .a-text-price .a-offscreen').first().text(),
        $('.basisPrice .a-offscreen').first().text(),
        $('.a-text-price .a-offscreen').first().text(),
        $('#priceblock_listprice').text(),
        $('.priceBlockStrikePriceString').first().text(),
      ) ?? null;

    const priceRangeText =
      H.firstNonEmpty(
        $('.a-price-range').first().text(),
        $('#corePrice_feature_div .a-price-range').first().text(),
      ) ?? null;

    const couponText =
      H.firstNonEmpty(
        $('#couponTextpctch').text(),
        $('#couponText').text(),
        $('[id*="couponText"]').first().text(),
        $('[data-csa-c-content-id="coupon"]').first().text(),
      ) ?? null;

    const jsonLdPrice = H.parseNumberLike(
      H.getJsonLdString(this.extractOfferField(productJsonLd, 'price')),
    );

    const jsonLdLowPrice = H.parseNumberLike(
      H.getJsonLdString(this.extractOfferField(productJsonLd, 'lowPrice')),
    );

    const jsonLdHighPrice = H.parseNumberLike(
      H.getJsonLdString(this.extractOfferField(productJsonLd, 'highPrice')),
    );

    const range = H.parsePriceRange(priceRangeText);

    const currencyCode =
      H.firstNonEmpty(
        H.getJsonLdString(
          this.extractOfferField(productJsonLd, 'priceCurrency'),
        ),
      ) ??
      H.detectCurrencyCode(
        H.firstNonEmpty(priceText, listPriceText, priceRangeText, couponText),
      );

    return {
      priceAmount: H.parsePrice(priceText) ?? jsonLdPrice,
      listPriceAmount: H.parsePrice(listPriceText),
      priceMinAmount: range?.min ?? jsonLdLowPrice,
      priceMaxAmount: range?.max ?? jsonLdHighPrice,
      couponAmount: H.parseCouponAmount(couponText),
      couponText,
      couponPercent: H.parseCouponPercent(couponText),
      currencyCode,
      jsonLdRating: H.parseNumberLike(
        H.getJsonLdString(productJsonLd?.aggregateRating?.ratingValue),
      ),
      jsonLdReviewCount: H.parseInteger(
        H.getJsonLdString(productJsonLd?.aggregateRating?.reviewCount),
      ),
      jsonLdAvailability: H.availabilityFromJsonLd(
        H.getJsonLdString(
          this.extractOfferField(productJsonLd, 'availability'),
        ),
      ),
    };
  }

  private extractMerchantSeller(
    $: cheerio.CheerioAPI,
    baseUrl: string,
    merchantText: string | null,
  ): ParsedSeller | null {
    const href =
      H.firstNonEmpty(
        $('#sellerProfileTriggerId').attr('href'),
        $('#merchantInfo a').first().attr('href'),
        $('#tabular-buybox-container a').first().attr('href'),
        $('#tabular-buybox a').first().attr('href'),
      ) ?? null;

    const rawId =
      this.extractQueryParamFromHref(href, 'seller') ??
      this.extractQueryParamFromHref(href, 'merchant') ??
      this.extractQueryParamFromHref(href, 'me') ??
      this.extractQueryParamFromHref(href, 'sellerID') ??
      this.extractQueryParamFromHref(href, 'sellerId');

    const label = H.normalizeSeller(merchantText);
    const id = H.buildEntityId('SELLER', rawId, label);

    if (!id) {
      return null;
    }

    return {
      id,
      type: 'SELLER',
      label,
      url: href ? H.toAbsoluteUrl(href, baseUrl) : null,
    };
  }

  private isBookProduct(
    breadcrumbs: string[],
    bylineText: string | null,
  ): boolean {
    const breadcrumbValue = breadcrumbs.join(' ').toLowerCase();

    return (
      breadcrumbValue.includes('books') ||
      /\((author|authors?|editor|illustrator)\)/i.test(bylineText ?? '')
    );
  }

  private extractAuthorSeller(
    $: cheerio.CheerioAPI,
    productJsonLd: Record<string, any> | null,
    baseUrl: string,
    bylineText: string | null,
  ): ParsedSeller | null {
    const href =
      H.firstNonEmpty(
        $('#bylineInfo').attr('href'),
        $('#bylineInfo a').first().attr('href'),
      ) ?? null;

    const label = H.normalizeAuthor(
      H.firstNonEmpty(
        bylineText,
        this.extractAuthorNameFromJsonLd(productJsonLd),
      ),
    );

    const rawId =
      this.extractQueryParamFromHref(href, 'authorID') ??
      this.extractQueryParamFromHref(href, 'authorId') ??
      href?.match(/\/author\/([A-Za-z0-9._:=~-]+)/i)?.[1] ??
      href?.match(/\/(?:-\/)?e\/([A-Za-z0-9._:=~-]+)/i)?.[1] ??
      href?.match(/\/gp\/profile\/([A-Za-z0-9._:=~-]+)/i)?.[1] ??
      null;

    const id = H.buildEntityId('AUTHOR', rawId, label);

    if (!id) {
      return null;
    }

    return {
      id,
      type: 'AUTHOR',
      label,
      url: href ? H.toAbsoluteUrl(href, baseUrl) : null,
    };
  }

  private extractAuthorNameFromJsonLd(
    productJsonLd: Record<string, any> | null,
  ): string | null {
    if (!productJsonLd) return null;

    const author = productJsonLd.author;

    if (typeof author === 'string') {
      return H.clean(author);
    }

    if (Array.isArray(author)) {
      const firstAuthor = author.find(
        (item) => typeof item === 'string' || item?.name,
      );

      if (typeof firstAuthor === 'string') {
        return H.clean(firstAuthor);
      }

      if (firstAuthor && typeof firstAuthor === 'object') {
        return H.clean(firstAuthor.name);
      }
    }

    if (author && typeof author === 'object') {
      return H.clean(author.name);
    }

    return null;
  }

  private extractQueryParamFromHref(
    href?: string | null,
    key?: string,
  ): string | null {
    if (!href || !key) {
      return null;
    }

    try {
      const url = new URL(href, 'https://www.amazon.com');
      return url.searchParams.get(key);
    } catch {
      return null;
    }
  }

  private extractMedia(
    $: cheerio.CheerioAPI,
    productJsonLd: Record<string, any> | null,
  ): string[] {
    const media = new Set<string>();

    [
      '#landingImage',
      '#imgBlkFront',
      '#ebooksImgBlkFront',
      '#main-image-container img',
      '#imageBlock img',
      '#altImages img',
      '#image-gallery img',
    ].forEach((selector) => {
      $(selector).each((_, el) => {
        const src =
          H.normalizeImage($(el).attr('data-old-hires')) ??
          H.normalizeImage($(el).attr('src')) ??
          H.normalizeImage($(el).attr('data-src'));

        if (H.isRealImageUrl(src)) {
          media.add(src);
        }
      });
    });

    if (productJsonLd?.image) {
      if (Array.isArray(productJsonLd.image)) {
        for (const image of productJsonLd.image) {
          const normalized = H.normalizeImage(
            typeof image === 'string' ? image : '',
          );

          if (H.isRealImageUrl(normalized)) {
            media.add(normalized);
          }
        }
      } else if (typeof productJsonLd.image === 'string') {
        const normalized = H.normalizeImage(productJsonLd.image);

        if (H.isRealImageUrl(normalized)) {
          media.add(normalized);
        }
      }
    }

    return Array.from(media);
  }

  private buildGroupId(currentAsin: string, variationAsins: string[]): string {
    const normalized = Array.from(
      new Set(
        [currentAsin, ...variationAsins]
          .map((asin) => H.normalizeAsin(asin))
          .filter((asin): asin is string => Boolean(asin)),
      ),
    ).sort();

    if (normalized.length <= 1) {
      return currentAsin;
    }

    return H.sha256(normalized.join('|'));
  }

  private extractVariationTheme(
    html: string,
    $: cheerio.CheerioAPI,
  ): string | null {
    const domLabels = H.dedupeStrings([
      $('#variation_size_name .a-form-label').first().text(),
      $('#variation_color_name .a-form-label').first().text(),
      $('#variation_style_name .a-form-label').first().text(),
      $('#variation_pattern_name .a-form-label').first().text(),
      $('#variation_capacity_name .a-form-label').first().text(),
      $('#variation_format_name .a-form-label').first().text(),
    ]);

    if (domLabels.length > 0) {
      return domLabels.join(', ');
    }

    const regexes = [
      /"variationDisplayLabels"\s*:\s*\{([^}]+)\}/i,
      /"variationValues"\s*:\s*\{([^}]+)\}/i,
    ];

    for (const regex of regexes) {
      const match = html.match(regex);
      const body = match?.[1];
      if (!body) continue;

      const keyMatch = body.match(/"([^"]+)"/);
      const key = H.clean(keyMatch?.[1]);
      if (key) return key;
    }

    return null;
  }

  private extractVariationAsins(
    $: cheerio.CheerioAPI,
    currentAsin: string,
  ): string[] {
    const asins = new Set<string>();

    const add = (value?: string | null): void => {
      const asin = H.normalizeAsin(value);
      if (!asin) {
        return;
      }

      if (!/\d/.test(asin)) {
        return;
      }

      asins.add(asin);
    };

    add(currentAsin);

    const variationScope = $(
      '#twister, #twisterContainer, [id^="variation_"], [id^="inline-twister-expander-content-"]',
    );

    if (variationScope.length === 0) {
      return Array.from(asins).sort();
    }

    variationScope
      .find(
        [
          '[data-defaultasin]',
          '[data-asin]',
          '[data-csa-c-item-id]',
          '[data-dp-url]',
          'li[data-asin]',
          'input[data-asin]',
          'a[href*="/dp/"]',
          'a[href*="/gp/product/"]',
        ].join(', '),
      )
      .each((_, el) => {
        const node = $(el);

        add(node.attr('data-defaultasin'));
        add(node.attr('data-asin'));
        add(node.attr('data-csa-c-item-id'));
        add(H.extractAsinFromUrl(node.attr('data-dp-url') ?? ''));
        add(H.extractAsinFromUrl(node.attr('href') ?? ''));
      });

    return Array.from(asins).sort();
  }
}
