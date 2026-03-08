import { Module } from '@nestjs/common';
import { AmazonParserModule } from './parser/parser.module';

@Module({
  imports: [AmazonParserModule],
})
export class AppModule {}
