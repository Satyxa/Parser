import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { AmazonHttpService } from './amazon-http.service';
import { AmazonParserHelpers as H } from './amazon-parser.helpers';
import {
  CategoryListingResult,
  ParsedCategory,
  ProductLink,
} from './parser.types';

@Injectable()
export class AmazonListingParserService {
  private readonly logger = new Logger(AmazonListingParserService.name);

  private readonly maxListingPages = Number(
    process.env.AMAZON_MAX_LISTING_PAGES ?? 3,
  );

  private readonly maxProducts = Number(process.env.AMAZON_MAX_PRODUCTS ?? 50);

  constructor(private readonly http: AmazonHttpService) {}

  async crawlCategory(seedUrl: string): Promise<CategoryListingResult> {
    const visitedPages = new Set<string>();
    const seenProducts = new Map<string, ProductLink>();

    let currentUrl: string | null = seedUrl;
    let page = 1;
    let category: ParsedCategory | null = null;

    while (currentUrl && page <= this.maxListingPages) {
      if (visitedPages.has(currentUrl)) {
        break;
      }

      visitedPages.add(currentUrl);

      this.logger.log(`Listing page ${page}: ${currentUrl}`);

      const html = await this.http.getHtml(currentUrl);

      if (!category) {
        category = this.parseCategoryInfo(html, currentUrl);
      }

      const parsedPage = this.parseListingPage(html, currentUrl);

      this.logger.log(
        `Listing page ${page}: unique products on page = ${parsedPage.products.length}, nextPage = ${parsedPage.nextPageUrl ?? 'null'}`,
      );

      for (const product of parsedPage.products) {
        this.upsertProductCandidate(seenProducts, product);
      }

      if (seenProducts.size >= this.maxProducts) {
        break;
      }

      currentUrl = parsedPage.nextPageUrl;
      page += 1;
    }

    if (!category) {
      category = {
        amazonNodeId: H.extractAmazonNodeId(seedUrl),
        name: this.resolveCategoryNameFromUrl(seedUrl) ?? 'Unknown category',
        url: seedUrl,
        breadcrumbs: [],
      };
    }

    return {
      category,
      productLinks: Array.from(seenProducts.values()).slice(
        0,
        this.maxProducts,
      ),
    };
  }

  private parseCategoryInfo(html: string, pageUrl: string): ParsedCategory {
    const $ = cheerio.load(html);

    const breadcrumbTexts = H.dedupeStrings(
      $('#wayfinding-breadcrumbs_feature_div ul li')
        .map((_, el) => this.normalizeCategoryText($(el).text()))
        .get(),
    ).filter((item) => item !== '›');

    const h1Clone = $('h1').first().clone();
    h1Clone.find('*').remove();

    const h1Text = this.normalizeCategoryText(h1Clone.text());
    const titleText = this.normalizeCategoryText($('title').first().text());
    const ogTitle = this.normalizeCategoryText(
      $('meta[property="og:title"]').attr('content'),
    );

    const candidates: string[] = [];

    const lastBreadcrumb =
      breadcrumbTexts.length > 0
        ? breadcrumbTexts[breadcrumbTexts.length - 1]
        : null;

    if (lastBreadcrumb) {
      candidates.push(lastBreadcrumb);
    }

    const normalizedTitle = this.normalizeSearchPageTitle(titleText);
    if (normalizedTitle) {
      candidates.push(normalizedTitle);
    }

    const normalizedOgTitle = this.normalizeSearchPageTitle(ogTitle);
    if (normalizedOgTitle) {
      candidates.push(normalizedOgTitle);
    }

    const normalizedH1 = this.normalizeSearchPageTitle(h1Text);
    if (normalizedH1) {
      candidates.push(normalizedH1);
    }

    const categoryFromUrl = this.resolveCategoryNameFromUrl(pageUrl);
    if (categoryFromUrl) {
      candidates.push(categoryFromUrl);
    }

    let name: string | null = null;

    for (const candidate of candidates) {
      if (!this.isGarbageCategoryTitle(candidate)) {
        name = candidate;
        break;
      }
    }

    if (!name) {
      name = this.resolveCategoryNameFromUrl(pageUrl) ?? 'Unknown category';
    }

    return {
      amazonNodeId: H.extractAmazonNodeId(pageUrl),
      name,
      url: pageUrl,
      breadcrumbs: breadcrumbTexts,
    };
  }

  private normalizeSearchPageTitle(value: string | null): string | null {
    if (!value) return null;

    const cleaned = this.normalizeCategoryText(
      value
        .replace(/\s*:\s*Amazon\.com.*$/i, '')
        .replace(/^Amazon\.com\s*:\s*/i, '')
        .replace(/\|\s*Amazon.*$/i, '')
        .replace(/^\d+\s*-\s*\d+\s+of\s+.*?\s+results?\s*/i, '')
        .replace(/\bSort by\b.*$/i, '')
        .replace(/\bFeatured\b.*$/i, ''),
    );

    if (!cleaned) {
      return null;
    }

    if (this.isGarbageCategoryTitle(cleaned)) {
      return null;
    }

    return cleaned;
  }

  private normalizeCategoryText(value?: string | null): string | null {
    if (!value) return null;

    const withoutHtml = value.replace(/<[^>]+>/g, ' ');
    const withoutEntities = withoutHtml
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"');

    return H.clean(withoutEntities);
  }

  private isGarbageCategoryTitle(value: string | null): boolean {
    if (!value) return true;

    const normalized = value.toLowerCase();

    return (
      normalized.includes('sort by') ||
      normalized.includes('price: low to high') ||
      normalized.includes('price: high to low') ||
      normalized.includes('avg. customer review') ||
      normalized.includes('results') ||
      normalized.includes('span class') ||
      normalized.includes('input') ||
      normalized.length > 120
    );
  }

  private resolveCategoryNameFromUrl(url: string): string | null {
    try {
      const parsed = new URL(url);

      const iParam = parsed.searchParams.get('i');
      const normalizedIParam = iParam ? iParam.toLowerCase() : null;

      const knownBySearchParam: Record<string, string> = {
        electronics: 'Electronics',
        stripbooks: 'Books',
        fashion: 'Fashion',
        computers: 'Computers',
        'office-products': 'Office Products',
      };

      if (normalizedIParam && knownBySearchParam[normalizedIParam]) {
        return knownBySearchParam[normalizedIParam];
      }

      if (parsed.pathname.includes('/amz-books/store')) {
        return 'Books';
      }

      return null;
    } catch {
      return null;
    }
  }

  private parseListingPage(
    html: string,
    pageUrl: string,
  ): { products: ProductLink[]; nextPageUrl: string | null } {
    const $ = cheerio.load(html);
    const origin = new URL(pageUrl).origin;
    const seen = new Map<string, ProductLink>();

    for (const candidate of this.extractListingProductsFromSearchDom(
      $,
      pageUrl,
    )) {
      this.upsertProductCandidate(seen, candidate);
    }

    for (const candidate of this.extractListingProductsFromGenericDom(
      $,
      pageUrl,
    )) {
      this.upsertProductCandidate(seen, candidate);
    }

    for (const candidate of this.extractListingProductsFromRawHtml(
      html,
      origin,
      pageUrl,
    )) {
      this.upsertProductCandidate(seen, candidate);
    }

    return {
      products: Array.from(seen.values()),
      nextPageUrl: this.extractNextPageUrl($, pageUrl),
    };
  }

  private extractListingProductsFromSearchDom(
    $: cheerio.CheerioAPI,
    pageUrl: string,
  ): ProductLink[] {
    const seen = new Map<string, ProductLink>();

    $('[data-component-type="s-search-result"][data-asin]').each((_, el) => {
      const item = $(el);

      const asin = H.normalizeAsin(item.attr('data-asin'));
      if (!asin) return;

      const href =
        item.find('h2 a').first().attr('href') ??
        item.find('.s-product-image-container a').first().attr('href') ??
        item.find('a[href*="/dp/"]').first().attr('href') ??
        item.find('a[href*="/gp/product/"]').first().attr('href');

      const url = this.buildProductUrl(pageUrl, href, asin);
      if (!url) return;

      const title =
        H.firstNonEmpty(
          item.find('h2 span').first().text(),
          item.find('h2 a span').first().text(),
          item.find('img').first().attr('alt'),
        ) ?? null;

      const image =
        H.firstNonEmpty(
          H.normalizeImage(item.find('img.s-image').first().attr('src')),
          H.normalizeImage(item.find('img').first().attr('src')),
          H.normalizeImage(item.find('img').first().attr('data-src')),
        ) ?? null;

      seen.set(asin, {
        asin,
        url,
        title,
        image,
        sourceUrl: pageUrl,
      });
    });

    return Array.from(seen.values());
  }

  private extractListingProductsFromGenericDom(
    $: cheerio.CheerioAPI,
    pageUrl: string,
  ): ProductLink[] {
    const seen = new Map<string, ProductLink>();
    const origin = new URL(pageUrl).origin;

    let root: cheerio.Cheerio<any>;

    if ($('main').first().length > 0) {
      root = $('main').first();
    } else if ($('#a-page').first().length > 0) {
      root = $('#a-page').first();
    } else {
      root = $('body').first();
    }

    root
      .find(
        [
          '[data-asin]',
          '.a-carousel-card',
          '[role="listitem"]',
          'article',
          'li',
          'div',
        ].join(', '),
      )
      .each((_, el) => {
        const item = $(el);

        if (
          item.parents(
            'header, footer, nav, #navFooter, #nav-main, #nav-subnav, #nav-xshop',
          ).length
        ) {
          return;
        }

        const asin =
          H.normalizeAsin(item.attr('data-asin')) ??
          H.extractAsinFromUrl(
            item.find('a[href*="/dp/"]').first().attr('href') ?? '',
          ) ??
          H.extractAsinFromUrl(
            item.find('a[href*="/gp/product/"]').first().attr('href') ?? '',
          );

        if (!asin) return;

        const href =
          item.find('a[href*="/dp/"]').first().attr('href') ??
          item.find('a[href*="/gp/product/"]').first().attr('href');

        const url = this.buildProductUrl(pageUrl, href, asin);
        if (!url) return;

        const cardText = H.clean(item.text()) ?? '';

        const title =
          H.firstNonEmpty(
            item.find('h2').first().text(),
            item.find('h3').first().text(),
            item.find('a[title]').first().attr('title'),
            item.find('img').first().attr('alt'),
          ) ?? null;

        const image =
          H.firstNonEmpty(
            H.normalizeImage(item.find('img').first().attr('src')),
            H.normalizeImage(item.find('img').first().attr('data-src')),
          ) ?? null;

        const looksLikeRealCard =
          Boolean(image) ||
          Boolean(title) ||
          /\$\s?\d/.test(cardText) ||
          /\b(stars?|reviews?|paperback|hardcover|kindle|camera|photo|electronics|headphones|books?)\b/i.test(
            cardText,
          );

        if (!looksLikeRealCard) return;

        seen.set(asin, {
          asin,
          url: H.toAbsoluteUrl(url, origin) ?? url,
          title,
          image,
          sourceUrl: pageUrl,
        });
      });

    return Array.from(seen.values());
  }

  private extractListingProductsFromRawHtml(
    html: string,
    origin: string,
    pageUrl: string,
  ): ProductLink[] {
    const seen = new Map<string, ProductLink>();
    const decodedHtml = H.decodeEscapedHtml(html);

    const patterns = [
      /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?"][^"'\\<\s]*)?/gi,
      /https?:\/\/www\.amazon\.com\/(?:[^"'\\<\s]*\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?"][^"'\\<\s]*)?/gi,
    ];

    for (const pattern of patterns) {
      const matches = decodedHtml.matchAll(pattern);

      for (const match of matches) {
        const asin = H.normalizeAsin(match[1]);
        if (!asin) continue;

        const index = match.index ?? 0;
        const start = Math.max(0, index - 1200);
        const end = Math.min(decodedHtml.length, index + 1200);
        const context = decodedHtml.slice(start, end);

        if (!this.isLikelyProductCardContext(context)) {
          continue;
        }

        const title =
          H.firstNonEmpty(
            this.extractQuotedFieldNear(context, ['title', 'alt', 'name']),
            this.extractHtmlTitleNear(context),
          ) ?? null;

        const image = this.extractImageUrlNear(context);

        seen.set(asin, {
          asin,
          url: `${origin}/dp/${asin}`,
          title,
          image,
          sourceUrl: pageUrl,
        });
      }
    }

    return Array.from(seen.values());
  }

  private extractNextPageUrl(
    $: cheerio.CheerioAPI,
    pageUrl: string,
  ): string | null {
    const href =
      H.firstNonEmpty(
        $('a.s-pagination-next:not(.s-pagination-disabled)').attr('href'),
        $('.s-pagination-container a[aria-label="Go to next page"]').attr(
          'href',
        ),
        $('ul.a-pagination li.a-last a').attr('href'),
        $('li.a-last a').attr('href'),
      ) ?? null;

    if (!href) return null;

    return H.toAbsoluteUrl(href, pageUrl);
  }

  private extractQuotedFieldNear(
    context: string,
    keys: string[],
  ): string | null {
    for (const key of keys) {
      const patterns = [
        new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'i'),
        new RegExp(`${key}=("([^"]+)")`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = context.match(pattern);
        const value = H.clean(match?.[1] ?? match?.[2]);
        if (value) return value;
      }
    }

    return null;
  }

  private extractHtmlTitleNear(context: string): string | null {
    const patterns = [/<img[^>]+alt="([^"]+)"/i, /aria-label="([^"]+)"/i];

    for (const pattern of patterns) {
      const match = context.match(pattern);
      const value = H.clean(match?.[1]);
      if (value) return value;
    }

    return null;
  }

  private extractImageUrlNear(context: string): string | null {
    const match = context.match(
      /https?:\/\/m\.media-amazon\.com\/images\/[^"' )\\]+/i,
    );

    const image = H.normalizeImage(match?.[0]);
    return H.isRealImageUrl(image) ? image : null;
  }

  private isLikelyProductCardContext(context: string): boolean {
    return (
      /m\.media-amazon\.com\/images/i.test(context) ||
      /\$\s?\d/.test(context) ||
      /\b(stars?|reviews?|paperback|hardcover|kindle|camera|electronics|photo|headphones|books?)\b/i.test(
        context,
      )
    );
  }

  private buildProductUrl(
    pageUrl: string,
    href: string | undefined,
    asin: string,
  ): string | null {
    if (!asin) return null;

    if (href) {
      const absolute = H.toAbsoluteUrl(href, pageUrl);
      if (absolute) {
        return `${new URL(absolute).origin}/dp/${asin}`;
      }
    }

    return `${new URL(pageUrl).origin}/dp/${asin}`;
  }

  private upsertProductCandidate(
    seen: Map<string, ProductLink>,
    candidate: ProductLink,
  ): void {
    const existing = seen.get(candidate.asin);

    if (!existing) {
      seen.set(candidate.asin, candidate);
      return;
    }

    const existingScore =
      Number(Boolean(existing.title)) +
      Number(Boolean(existing.image)) +
      Number(Boolean(existing.url));

    const newScore =
      Number(Boolean(candidate.title)) +
      Number(Boolean(candidate.image)) +
      Number(Boolean(candidate.url));

    if (newScore > existingScore) {
      seen.set(candidate.asin, candidate);
    }
  }
}
