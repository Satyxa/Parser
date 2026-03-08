export type AvailabilityStatus = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
export type SellerType = 'SELLER' | 'AUTHOR';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProductLink {
  asin: string;
  url: string;
  sourceUrl: string;
  title: string | null;
  image: string | null;
}

export interface ParsedCategory {
  amazonNodeId: string | null;
  name: string;
  url: string;
  breadcrumbs: string[];
}

export interface ParsedSeller {
  id: string;
  type: SellerType;
  label: string | null;
  url: string | null;
}

export interface ParsedReview {
  amazonReviewId: string;
  rating: number | null;
  reviewCreatedAt: Date | null;
  reviewCreatedAtRaw: string | null;
  verifiedPurchase: boolean | null;
  helpfulVotes: number | null;
  title: string | null;
  text: string | null;
  authorName: string | null;
  media: string[];
  contentHash: string;
}

export interface ParsedProduct {
  asin: string;
  canonicalUrl: string | null;
  variationGroupKey: string | null;
  variationAsins: string[];
  title: string;
  seller: ParsedSeller | null;
  variationTheme: string | null;
  hasVariations: boolean;

  priceAmount: number | null;
  listPriceAmount: number | null;
  priceMinAmount: number | null;
  priceMaxAmount: number | null;
  couponAmount: number | null;
  currencyCode: string | null;

  avgRating: number | null;
  reviewsCount: number | null;
  availabilityStatus: AvailabilityStatus;

  breadcrumbs: string[];
  media: string[];
  attributesJson: Record<string, unknown> | null;
  reviews: ParsedReview[];
}

export interface CategoryListingResult {
  category: ParsedCategory;
  productLinks: ProductLink[];
}

export interface CategorySavePayload {
  amazonNodeId: string | null;
  name: string;
  url: string | null;
  parentId: bigint | null;
  attributeSchemaJson: Record<string, unknown> | null;
}

export interface SellerSavePayload {
  id: string;
  type: SellerType;
  label: string | null;
  url: string | null;
}

export interface ProductSavePayload {
  asin: string;
  canonicalUrl: string | null;
  title: string;
  sellerId: string | null;

  variationGroupKey: string | null;
  variationTheme: string | null;
  hasVariations: boolean;

  priceAmount: number | null;
  listPriceAmount: number | null;
  priceMinAmount: number | null;
  priceMaxAmount: number | null;
  couponAmount: number | null;
  currencyCode: string | null;

  avgRating: number | null;
  reviewsCount: number | null;
  availabilityStatus: AvailabilityStatus;
  attributesJson: Record<string, unknown> | null;
}

export interface ProductSnapshotSavePayload {
  productAsin: string;
  priceAmount: number | null;
  listPriceAmount: number | null;
  priceMinAmount: number | null;
  priceMaxAmount: number | null;
  couponAmount: number | null;
  currencyCode: string | null;
  avgRating: number | null;
  availabilityStatus: AvailabilityStatus;
}

export interface ReviewSavePayload {
  productAsin: string;
  amazonReviewId: string;
  rating: number | null;
  reviewCreatedAt: Date | null;
  verifiedPurchase: boolean | null;
  helpfulVotes: number | null;
  contentHash: string | null;
}

export interface ProductCategoryStubPayload {
  productAsin: string;
  isPrimary: boolean;
  resolvedCategoryId: bigint | null;
  categoryLookup: {
    amazonNodeId: string | null;
    url: string;
    name: string;
  };
}

export interface PreparedSaveBundle {
  category: CategorySavePayload;
  seller: SellerSavePayload | null;
  product: ProductSavePayload;
  productSnapshot: ProductSnapshotSavePayload;
  productCategory: ProductCategoryStubPayload;
  reviews: ReviewSavePayload[];

  raw: {
    category: ParsedCategory;
    product: ParsedProduct;
  };
}
