import { Injectable } from '@nestjs/common';
import {
  ParsedCategory,
  ParsedProduct,
  PreparedSaveBundle,
} from './parser.types';

@Injectable()
export class AmazonSavePlanFactory {
  build(category: ParsedCategory, product: ParsedProduct): PreparedSaveBundle {
    return {
      category: {
        amazonNodeId: category.amazonNodeId,
        name: category.name,
        url: category.url,
        parentId: null,
      },

      seller: product.seller
        ? {
            id: product.seller.id,
            type: product.seller.type,
            label: product.seller.label,
            url: product.seller.url,
          }
        : null,

      product: {
        asin: product.asin,
        canonicalUrl: product.canonicalUrl,
        title: product.title,
        sellerId: product.seller?.id ?? null,

        groupId: product.groupId,
        variationTheme: product.variationTheme,
        hasVariations: product.hasVariations,

        priceAmount: product.priceAmount,
        listPriceAmount: product.listPriceAmount,
        priceMinAmount: product.priceMinAmount,
        priceMaxAmount: product.priceMaxAmount,
        couponAmount: product.couponAmount,
        currencyCode: product.currencyCode,

        avgRating: product.avgRating,
        reviewsCount: product.reviewsCount,
        availabilityStatus: product.availabilityStatus,
      },

      productSnapshot: {
        productAsin: product.asin,
        priceAmount: product.priceAmount,
        listPriceAmount: product.listPriceAmount,
        priceMinAmount: product.priceMinAmount,
        priceMaxAmount: product.priceMaxAmount,
        couponAmount: product.couponAmount,
        currencyCode: product.currencyCode,
        avgRating: product.avgRating,
        availabilityStatus: product.availabilityStatus,
      },

      productCategory: {
        productAsin: product.asin,
        isPrimary: true,
        resolvedCategoryId: null,
        categoryLookup: {
          amazonNodeId: category.amazonNodeId,
          url: category.url,
          name: category.name,
        },
      },

      reviews: product.reviews.map((review) => ({
        groupId: product.groupId,
        amazonReviewId: review.amazonReviewId,
        rating: review.rating,
        reviewCreatedAt: review.reviewCreatedAt,
        verifiedPurchase: review.verifiedPurchase,
        helpfulVotes: review.helpfulVotes,
        contentHash: review.contentHash,
      })),

      raw: {
        category,
        product,
      },
    };
  }
}
