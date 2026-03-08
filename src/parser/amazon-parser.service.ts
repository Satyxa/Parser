import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AmazonListingParserService } from './amazon-listing-parser.service';
import { AmazonPersistenceService } from './amazon-persistence.service';
import { AmazonProductParserService } from './amazon-product-parser.service';
import { AmazonSavePlanFactory } from './amazon-save-plan.factory';
import { ParsedCategory, ParsedProduct, ProductLink } from './parser.types';

@Injectable()
export class AmazonParserService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AmazonParserService.name);

  private readonly defaultSeedUrls = [
    'https://www.amazon.com/s?i=electronics&rh=n%3A172282&fs=true',
    'https://www.amazon.com/s?i=stripbooks&rh=n%3A283155&fs=true',
  ];

  private readonly maxProducts = Number(process.env.AMAZON_MAX_PRODUCTS ?? 20);

  private readonly productConcurrency = Math.max(
    1,
    Number(process.env.AMAZON_PRODUCT_CONCURRENCY ?? 1),
  );

  private readonly maxVariationsPerProduct = Math.max(
    0,
    Number(process.env.AMAZON_MAX_VARIATIONS_PER_PRODUCT ?? 30),
  );

  private readonly processingProducts = new Map<string, Promise<boolean>>();
  private readonly savedProducts = new Set<string>();

  constructor(
    private readonly listingParser: AmazonListingParserService,
    private readonly productParser: AmazonProductParserService,
    private readonly savePlanFactory: AmazonSavePlanFactory,
    private readonly persistence: AmazonPersistenceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const autorun =
      (process.env.AMAZON_AUTORUN ?? 'true').toLowerCase() === 'true';

    if (!autorun) {
      this.logger.log('AMAZON_AUTORUN=false, parser startup skipped');
      return;
    }

    try {
      await this.run();
      this.logger.log('Parser run completed');
    } catch (error) {
      this.logger.error(
        `Parser run failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async run(seedUrls?: string | string[]): Promise<void> {
    const urls = this.resolveSeedUrls(seedUrls);

    this.logger.log(`Seed URLs count: ${urls.length}`);

    for (const seedUrl of urls) {
      await this.processSeed(seedUrl);
    }
  }

  private async processSeed(seedUrl: string): Promise<void> {
    this.logger.log(`Start seed: ${seedUrl}`);

    const listing = await this.listingParser.crawlCategory(seedUrl);

    this.logger.log(
      `Category "${listing.category.name}" (${listing.category.amazonNodeId ?? 'no-node-id'}) -> ${listing.productLinks.length} products found`,
    );

    const products = listing.productLinks.slice(0, this.maxProducts);

    for (const batch of this.chunk(products, this.productConcurrency)) {
      await Promise.all(
        batch.map((productLink) =>
          this.processProduct(listing.category, productLink),
        ),
      );
    }
  }

  private async processProduct(
    category: ParsedCategory,
    productLink: ProductLink,
  ): Promise<boolean> {
    if (this.savedProducts.has(productLink.asin)) {
      return true;
    }

    const existingPromise = this.processingProducts.get(productLink.asin);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = this.processProductInternal(category, productLink).finally(
      () => {
        this.processingProducts.delete(productLink.asin);
      },
    );

    this.processingProducts.set(productLink.asin, promise);

    return promise;
  }

  private async processProductInternal(
    category: ParsedCategory,
    productLink: ProductLink,
  ): Promise<boolean> {
    this.logger.log(
      `Processing product ${productLink.asin}: ${productLink.url}`,
    );

    try {
      const parsedProduct = await this.productParser.parseProduct(productLink);

      if (parsedProduct.asin !== productLink.asin) {
        this.logger.warn(
          `Requested ASIN ${productLink.asin} resolved to parsed ASIN ${parsedProduct.asin}`,
        );
      }

      this.logger.log(
        `Parsed product ${parsedProduct.asin}: title="${parsedProduct.title}", reviews=${parsedProduct.reviews.length}, price=${parsedProduct.priceAmount ?? 'null'}, avgRating=${parsedProduct.avgRating ?? 'null'}, groupId=${parsedProduct.groupId}, variationAsins=${parsedProduct.variationAsins.length}`,
      );

      const bundle = this.savePlanFactory.build(category, parsedProduct);

      await this.persistence.persist(bundle);

      this.savedProducts.add(productLink.asin);
      this.savedProducts.add(parsedProduct.asin);

      await this.processDiscoveredVariations(
        category,
        productLink,
        parsedProduct,
      );

      return true;
    } catch (error) {
      this.logger.error(
        `Failed to process product ${productLink.url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return false;
    }
  }

  private async processDiscoveredVariations(
    category: ParsedCategory,
    sourceLink: ProductLink,
    product: ParsedProduct,
  ): Promise<void> {
    if (this.maxVariationsPerProduct === 0) {
      return;
    }

    const variationAsins = Array.from(new Set(product.variationAsins))
      .filter((asin) => asin !== product.asin && asin !== sourceLink.asin)
      .filter((asin) => /^[A-Z0-9]{10}$/.test(asin))
      .filter((asin) => /\d/.test(asin))
      .slice(0, this.maxVariationsPerProduct);

    if (variationAsins.length === 0) {
      return;
    }

    this.logger.log(
      `ASIN ${product.asin}: discovered ${variationAsins.length} variation products`,
    );

    const links: ProductLink[] = variationAsins.map((asin) => ({
      asin,
      url: new URL(
        `/dp/${asin}`,
        product.canonicalUrl ?? sourceLink.url,
      ).toString(),
      sourceUrl: product.canonicalUrl ?? sourceLink.url,
      title: null,
      image: null,
    }));

    for (const batch of this.chunk(links, this.productConcurrency)) {
      await Promise.all(
        batch.map((variationLink) =>
          this.processProduct(category, variationLink),
        ),
      );
    }
  }

  private resolveSeedUrls(seedUrls?: string | string[]): string[] {
    if (Array.isArray(seedUrls)) {
      return seedUrls.map((item) => item.trim()).filter(Boolean);
    }

    if (typeof seedUrls === 'string' && seedUrls.trim()) {
      return seedUrls
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    if (process.env.AMAZON_SEED_URLS?.trim()) {
      return process.env.AMAZON_SEED_URLS.split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    return this.defaultSeedUrls;
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];

    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size));
    }

    return result;
  }
}
