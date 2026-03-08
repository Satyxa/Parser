import { Injectable, Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { PrismaService } from '../prisma/prisma.service';
import { AmazonHttpService } from './amazon-http.service';
import { AmazonParserHelpers as H } from './amazon-parser.helpers';
import { ParsedReview } from './parser.types';

@Injectable()
export class AmazonReviewParserService {
  private readonly logger = new Logger(AmazonReviewParserService.name);

  private readonly maxReviewPages = Number(
    process.env.AMAZON_MAX_REVIEW_PAGES ?? 2,
  );

  constructor(
    private readonly http: AmazonHttpService,
    private readonly prisma: PrismaService,
  ) {}

  async parseReviews(
    asin: string,
    productUrl: string,
    referer: string,
    productHtml: string,
  ): Promise<ParsedReview[]> {
    const seen = new Map<string, ParsedReview>();
    const origin = new URL(productUrl).origin;

    for (let page = 1; page <= this.maxReviewPages; page++) {
      const reviewUrl =
        `${origin}/product-reviews/${asin}/` +
        `?ie=UTF8&reviewerType=all_reviews&sortBy=recent&pageNumber=${page}`;

      let html: string;

      try {
        html = await this.http.getHtml(reviewUrl, referer);
      } catch (error) {
        this.logger.warn(
          `Reviews page failed for ASIN ${asin}, page ${page}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        break;
      }

      const reviews = this.extractReviewsFromHtml(html);

      this.logger.log(`ASIN ${asin} reviews page ${page}: ${reviews.length}`);

      if (reviews.length === 0) {
        break;
      }

      for (const review of reviews) {
        if (!seen.has(review.amazonReviewId)) {
          seen.set(review.amazonReviewId, review);
        }
      }

      const pageIsAlreadyIndexed = await this.isReviewPageAlreadyIndexed(
        asin,
        reviews,
      );

      if (pageIsAlreadyIndexed) {
        this.logger.log(
          `ASIN ${asin} reviews page ${page}: all reviews already indexed, stop pagination`,
        );
        break;
      }

      const $ = cheerio.load(html);
      const hasNextPage =
        $('.a-pagination .a-last a').length > 0 || $('li.a-last a').length > 0;

      if (!hasNextPage) {
        break;
      }
    }

    if (seen.size > 0) {
      return Array.from(seen.values());
    }

    const embeddedReviews = this.extractReviewsFromHtml(productHtml);

    this.logger.log(
      `ASIN ${asin} embedded reviews on product page: ${embeddedReviews.length}`,
    );

    return embeddedReviews;
  }

  private async isReviewPageAlreadyIndexed(
    productAsin: string,
    reviews: ParsedReview[],
  ): Promise<boolean> {
    if (reviews.length === 0) {
      return false;
    }

    const existingLinks = await this.prisma.reviewProduct.findMany({
      where: {
        productAsin,
        reviewAmazonReviewId: {
          in: reviews.map((review) => review.amazonReviewId),
        },
      },
      select: {
        reviewAmazonReviewId: true,
        review: {
          select: {
            contentHash: true,
          },
        },
      },
    });

    if (existingLinks.length !== reviews.length) {
      return false;
    }

    const existingMap = new Map(
      existingLinks.map((item) => [
        item.reviewAmazonReviewId,
        item.review.contentHash,
      ]),
    );

    return reviews.every(
      (review) => existingMap.get(review.amazonReviewId) === review.contentHash,
    );
  }

  private extractReviewsFromHtml(html: string): ParsedReview[] {
    const $ = cheerio.load(html);
    const items = new Map<string, ParsedReview>();

    const reviewNodes = $(
      [
        '#cm_cr-review_list [data-hook="review"]',
        'div[data-hook="review"]',
        '.review',
      ].join(', '),
    );

    reviewNodes.each((_, el) => {
      const review = $(el);

      const amazonReviewId =
        H.firstNonEmpty(
          review.attr('id'),
          review.attr('data-review-id'),
          review.find('[data-review-id]').first().attr('data-review-id'),
        ) ?? null;

      if (!amazonReviewId) {
        return;
      }

      const authorName =
        H.firstNonEmpty(
          review.find('span.a-profile-name').first().text(),
          review.find('[data-hook="review-author"]').first().text(),
        ) ?? null;

      const title =
        H.firstNonEmpty(
          review.find('[data-hook="review-title"] span').last().text(),
          review.find('[data-hook="review-title"]').first().text(),
        ) ?? null;

      const rating = H.parseRating(
        H.firstNonEmpty(
          review.find('i[data-hook="review-star-rating"] span').first().text(),
          review
            .find('i[data-hook="cmps-review-star-rating"] span')
            .first()
            .text(),
          review.find('[data-hook="review-star-rating"]').first().text(),
        ),
      );

      const text =
        H.stripAmazonReadMore(
          H.firstNonEmpty(
            review.find('span[data-hook="review-body"] span').text(),
            review.find('span[data-hook="review-body"]').text(),
            review.find('[data-hook="review-collapsed"]').text(),
            review.find('.review-text').text(),
          ),
        ) ?? null;

      const reviewCreatedAtRaw =
        H.firstNonEmpty(
          review.find('span[data-hook="review-date"]').first().text(),
          review.find('.review-date').first().text(),
        ) ?? null;

      const verifiedPurchaseText =
        H.firstNonEmpty(
          review.find('[data-hook="avp-badge"]').first().text(),
          review.find('.a-color-state.a-text-bold').first().text(),
        ) ?? null;

      const helpfulVotesText =
        H.firstNonEmpty(
          review.find('[data-hook="helpful-vote-statement"]').first().text(),
          review.find('.cr-vote-text').first().text(),
        ) ?? null;

      const media = review
        .find(
          'img[data-hook="review-image-tile"], .review-image-tile-section img, img',
        )
        .map((__, img) => H.normalizeImage($(img).attr('src')))
        .get()
        .filter((value): value is string => H.isRealImageUrl(value));

      if (!title && !text && !authorName) {
        return;
      }

      const contentHash = H.sha256(
        [title ?? '', text ?? '', rating ?? '', authorName ?? ''].join('|'),
      );

      const parsed: ParsedReview = {
        amazonReviewId,
        rating,
        reviewCreatedAt: H.parseReviewDate(reviewCreatedAtRaw),
        reviewCreatedAtRaw,
        verifiedPurchase: verifiedPurchaseText
          ? /verified purchase/i.test(verifiedPurchaseText)
          : null,
        helpfulVotes: H.parseHelpfulVotes(helpfulVotesText),
        title,
        text,
        authorName,
        media: Array.from(new Set(media)),
        contentHash,
      };

      items.set(parsed.amazonReviewId, parsed);
    });

    return Array.from(items.values());
  }
}
