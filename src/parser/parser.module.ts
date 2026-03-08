import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AmazonHttpService } from './amazon-http.service';
import { AmazonListingParserService } from './amazon-listing-parser.service';
import { AmazonParserService } from './amazon-parser.service';
import { AmazonPersistenceService } from './amazon-persistence.service';
import { AmazonProductParserService } from './amazon-product-parser.service';
import { AmazonReviewParserService } from './amazon-review-parser.service';
import { AmazonSavePlanFactory } from './amazon-save-plan.factory';

@Module({
  imports: [PrismaModule],
  providers: [
    AmazonHttpService,
    AmazonListingParserService,
    AmazonReviewParserService,
    AmazonProductParserService,
    AmazonSavePlanFactory,
    AmazonPersistenceService,
    AmazonParserService,
  ],
  exports: [AmazonParserService],
})
export class AmazonParserModule {}
