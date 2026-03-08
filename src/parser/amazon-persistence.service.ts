import { Injectable, Logger } from '@nestjs/common';
import { Category, Prisma, Product } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PreparedSaveBundle,
  ReviewSavePayload,
  SellerSavePayload,
} from './parser.types';

@Injectable()
export class AmazonPersistenceService {
  private readonly logger = new Logger(AmazonPersistenceService.name);

  constructor(private readonly prisma: PrismaService) {}

  async persist(bundle: PreparedSaveBundle): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const category = await this.saveCategory(tx, bundle);

      if (bundle.seller) {
        await this.saveSeller(tx, bundle.seller);
      }

      const existingProduct = await tx.product.findUnique({
        where: {
          asin: bundle.product.asin,
        },
        select: {
          priceAmount: true,
          listPriceAmount: true,
          priceMinAmount: true,
          priceMaxAmount: true,
          couponAmount: true,
          currencyCode: true,
          avgRating: true,
          availabilityStatus: true,
        },
      });

      const resolvedGroupId = await this.resolveCanonicalGroupId(tx, bundle);

      await this.saveProduct(tx, bundle, resolvedGroupId);

      if (this.shouldCreateSnapshot(existingProduct, bundle.productSnapshot)) {
        await this.saveSnapshot(tx, bundle.productSnapshot);
      }

      await this.saveProductCategory(tx, bundle, category.id);
      await this.saveReviews(tx, bundle.reviews, resolvedGroupId);
    });

    this.logger.log(
      `Saved ASIN ${bundle.product.asin}: product, category link, reviews=${bundle.reviews.length}`,
    );
  }

  private async saveCategory(
    tx: Prisma.TransactionClient,
    bundle: PreparedSaveBundle,
  ): Promise<Category> {
    const now = new Date();
    const data = bundle.category;

    const createData: Prisma.CategoryCreateInput = {
      amazonNodeId: data.amazonNodeId ?? undefined,
      name: data.name,
      url: data.url ?? undefined,
      parent:
        data.parentId != null
          ? {
              connect: {
                id: data.parentId,
              },
            }
          : undefined,
    };

    const updateData: Prisma.CategoryUpdateInput = {
      name: data.name,
      url: data.url ?? null,
      lastSeenAt: now,
    };

    if (data.amazonNodeId) {
      return tx.category.upsert({
        where: {
          amazonNodeId: data.amazonNodeId,
        },
        create: createData,
        update: updateData,
      });
    }

    const existing = await tx.category.findFirst({
      where: {
        name: data.name,
        url: data.url ?? null,
      },
    });

    if (existing) {
      return tx.category.update({
        where: {
          id: existing.id,
        },
        data: updateData,
      });
    }

    return tx.category.create({
      data: createData,
    });
  }

  private async saveSeller(
    tx: Prisma.TransactionClient,
    seller: SellerSavePayload,
  ): Promise<void> {
    const now = new Date();

    await tx.seller.upsert({
      where: {
        id: seller.id,
      },
      create: {
        id: seller.id,
        type: seller.type,
        label: seller.label,
        url: seller.url,
      },
      update: {
        type: seller.type,
        label: seller.label ?? undefined,
        url: seller.url ?? undefined,
        lastSeenAt: now,
      },
    });
  }

  private async saveProduct(
    tx: Prisma.TransactionClient,
    bundle: PreparedSaveBundle,
    groupId: string,
  ): Promise<void> {
    const now = new Date();
    const data = bundle.product;

    await tx.product.upsert({
      where: {
        asin: data.asin,
      },
      create: {
        asin: data.asin,
        canonicalUrl: data.canonicalUrl,
        title: data.title,
        sellerId: data.sellerId,
        groupId,
        variationTheme: data.variationTheme,
        hasVariations: data.hasVariations,
        priceAmount: data.priceAmount,
        listPriceAmount: data.listPriceAmount,
        priceMinAmount: data.priceMinAmount,
        priceMaxAmount: data.priceMaxAmount,
        couponAmount: data.couponAmount,
        currencyCode: data.currencyCode,
        avgRating: data.avgRating,
        reviewsCount: data.reviewsCount,
        availabilityStatus: data.availabilityStatus,
      },
      update: {
        canonicalUrl: data.canonicalUrl ?? undefined,
        title: data.title,
        sellerId: data.sellerId ?? undefined,
        groupId,
        variationTheme: data.variationTheme ?? undefined,
        hasVariations: data.hasVariations ? true : undefined,
        priceAmount: data.priceAmount ?? undefined,
        listPriceAmount: data.listPriceAmount ?? undefined,
        priceMinAmount: data.priceMinAmount ?? undefined,
        priceMaxAmount: data.priceMaxAmount ?? undefined,
        couponAmount: data.couponAmount ?? undefined,
        currencyCode: data.currencyCode ?? undefined,
        avgRating: data.avgRating ?? undefined,
        reviewsCount: data.reviewsCount ?? undefined,
        availabilityStatus:
          data.availabilityStatus !== 'UNKNOWN'
            ? data.availabilityStatus
            : undefined,
        lastSeenAt: now,
      },
    });
  }

  private async saveSnapshot(
    tx: Prisma.TransactionClient,
    data: PreparedSaveBundle['productSnapshot'],
  ): Promise<void> {
    await tx.productSnapshot.create({
      data: {
        productAsin: data.productAsin,
        priceAmount: data.priceAmount,
        listPriceAmount: data.listPriceAmount,
        priceMinAmount: data.priceMinAmount,
        priceMaxAmount: data.priceMaxAmount,
        couponAmount: data.couponAmount,
        currencyCode: data.currencyCode,
        avgRating: data.avgRating,
        availabilityStatus: data.availabilityStatus,
      },
    });
  }

  private async saveProductCategory(
    tx: Prisma.TransactionClient,
    bundle: PreparedSaveBundle,
    categoryId: bigint,
  ): Promise<void> {
    const now = new Date();
    const data = bundle.productCategory;

    await tx.productCategory.upsert({
      where: {
        productAsin_categoryId: {
          productAsin: data.productAsin,
          categoryId,
        },
      },
      create: {
        productAsin: data.productAsin,
        categoryId,
        isPrimary: data.isPrimary,
      },
      update: {
        isPrimary: data.isPrimary,
        lastSeenAt: now,
      },
    });
  }

  private async saveReviews(
    tx: Prisma.TransactionClient,
    reviews: ReviewSavePayload[],
    groupId: string,
  ): Promise<void> {
    if (reviews.length === 0) {
      return;
    }

    const now = new Date();
    const reviewIds = reviews.map((review) => review.amazonReviewId);

    const existingReviews = await tx.review.findMany({
      where: {
        amazonReviewId: {
          in: reviewIds,
        },
      },
      select: {
        amazonReviewId: true,
        contentHash: true,
        groupId: true,
      },
    });

    const existingMap = new Map(
      existingReviews.map((review) => [review.amazonReviewId, review]),
    );

    for (const review of reviews) {
      const existing = existingMap.get(review.amazonReviewId);

      if (!existing) {
        await tx.review.create({
          data: {
            amazonReviewId: review.amazonReviewId,
            groupId,
            rating: review.rating,
            reviewCreatedAt: review.reviewCreatedAt,
            verifiedPurchase: review.verifiedPurchase,
            helpfulVotes: review.helpfulVotes,
            contentHash: review.contentHash,
          },
        });

        continue;
      }

      const changed =
        existing.contentHash !== review.contentHash ||
        existing.groupId !== groupId;

      await tx.review.update({
        where: {
          amazonReviewId: review.amazonReviewId,
        },
        data: {
          groupId,
          rating: review.rating,
          reviewCreatedAt: review.reviewCreatedAt,
          verifiedPurchase: review.verifiedPurchase,
          helpfulVotes: review.helpfulVotes,
          contentHash: review.contentHash,
          lastSeenAt: now,
          lastChangedAt: changed ? now : undefined,
        },
      });
    }
  }

  private async resolveCanonicalGroupId(
    tx: Prisma.TransactionClient,
    bundle: PreparedSaveBundle,
  ): Promise<string> {
    const provisionalGroupId = bundle.product.groupId;

    const candidateAsins = Array.from(
      new Set(
        [bundle.product.asin, ...bundle.raw.product.variationAsins]
          .map((asin) => asin?.trim().toUpperCase())
          .filter((asin): asin is string => Boolean(asin)),
      ),
    );

    if (candidateAsins.length === 0) {
      return provisionalGroupId;
    }

    const existingProducts = await tx.product.findMany({
      where: {
        asin: {
          in: candidateAsins,
        },
      },
      select: {
        groupId: true,
        firstSeenAt: true,
      },
      orderBy: {
        firstSeenAt: 'asc',
      },
    });

    const existingGroupIds = Array.from(
      new Set(existingProducts.map((product) => product.groupId)),
    );

    const canonicalGroupId = existingGroupIds[0] ?? provisionalGroupId;
    const groupIdsToMerge = existingGroupIds.filter(
      (groupId) => groupId !== canonicalGroupId,
    );

    if (groupIdsToMerge.length > 0) {
      await this.mergeGroupIds(tx, canonicalGroupId, groupIdsToMerge);
    }

    return canonicalGroupId;
  }

  private async mergeGroupIds(
    tx: Prisma.TransactionClient,
    canonicalGroupId: string,
    groupIdsToMerge: string[],
  ): Promise<void> {
    if (groupIdsToMerge.length === 0) {
      return;
    }

    await tx.product.updateMany({
      where: {
        groupId: {
          in: groupIdsToMerge,
        },
      },
      data: {
        groupId: canonicalGroupId,
      },
    });

    await tx.review.updateMany({
      where: {
        groupId: {
          in: groupIdsToMerge,
        },
      },
      data: {
        groupId: canonicalGroupId,
      },
    });
  }

  private shouldCreateSnapshot(
    existing: Pick<
      Product,
      | 'priceAmount'
      | 'listPriceAmount'
      | 'priceMinAmount'
      | 'priceMaxAmount'
      | 'couponAmount'
      | 'currencyCode'
      | 'avgRating'
      | 'availabilityStatus'
    > | null,
    incoming: PreparedSaveBundle['productSnapshot'],
  ): boolean {
    const hasTrackedIncomingValue =
      incoming.priceAmount != null ||
      incoming.listPriceAmount != null ||
      incoming.priceMinAmount != null ||
      incoming.priceMaxAmount != null ||
      incoming.couponAmount != null ||
      incoming.currencyCode != null ||
      incoming.avgRating != null ||
      incoming.availabilityStatus !== 'UNKNOWN';

    if (!hasTrackedIncomingValue) {
      return false;
    }

    if (!existing) {
      return true;
    }

    return (
      this.stringifyComparable(existing.priceAmount) !==
        this.stringifyComparable(incoming.priceAmount) ||
      this.stringifyComparable(existing.listPriceAmount) !==
        this.stringifyComparable(incoming.listPriceAmount) ||
      this.stringifyComparable(existing.priceMinAmount) !==
        this.stringifyComparable(incoming.priceMinAmount) ||
      this.stringifyComparable(existing.priceMaxAmount) !==
        this.stringifyComparable(incoming.priceMaxAmount) ||
      this.stringifyComparable(existing.couponAmount) !==
        this.stringifyComparable(incoming.couponAmount) ||
      this.stringifyComparable(existing.currencyCode) !==
        this.stringifyComparable(incoming.currencyCode) ||
      this.stringifyComparable(existing.avgRating) !==
        this.stringifyComparable(incoming.avgRating) ||
      this.stringifyComparable(existing.availabilityStatus) !==
        this.stringifyComparable(incoming.availabilityStatus)
    );
  }

  private stringifyComparable(value: unknown): string | null {
    if (value == null) {
      return null;
    }

    return String(value);
  }
}
