import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';

@Injectable()
export class ParserService {
  private readonly logger = new Logger(ParserService.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({
      timeout: 30000,
      maxRedirects: 5,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        referer: 'https://www.amazon.com/',
      },
    });
  }

  async run(): Promise<void> {
    const url =
      'https://www.amazon.com/amz-books/store?ref_=nav_em_usf_t1_0_2_16_2';

    const html = await this.fetchHtml(url);
    this.ensureNotBlocked(html, url);

    const books = this.extractBooksFromCurrentPage(html);

    this.logger.log(`Books found on current page: ${books.length}`);
    console.log(JSON.stringify(books.slice(0, 30), null, 2));
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await this.http.get<string>(url, {
      responseType: 'text',
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }

    return response.data;
  }

  private ensureNotBlocked(html: string, url: string): void {
    const lowerHtml = html.toLowerCase();

    const isCaptcha =
      lowerHtml.includes('enter the characters you see below') ||
      lowerHtml.includes(
        "sorry, we just need to make sure you're not a robot",
      ) ||
      lowerHtml.includes('/errors/validatecaptcha');

    if (isCaptcha) {
      throw new Error(`Amazon anti-bot page detected for ${url}`);
    }
  }

  private extractBooksFromCurrentPage(html: string) {
    const page = cheerio.load(html);

    const root =
      page('main').first().length > 0
        ? page('main').first()
        : page('#pageContent').first().length > 0
          ? page('#pageContent').first()
          : page('body');

    const booksMap = new Map<
      string,
      {
        asin: string | null;
        url: string;
        title: string | null;
        image: string | null;
      }
    >();

    root.find('a[href*="/dp/"], a[href*="/gp/product/"]').each((_, element) => {
      const link = page(element);
      const href = link.attr('href');
      const productUrl = this.normalizeAmazonProductUrl(href);

      if (!productUrl) {
        return;
      }

      const container = link.closest('div');

      const title =
        this.cleanText(link.attr('aria-label')) ||
        this.cleanText(link.find('img').first().attr('alt')) ||
        this.cleanText(link.text()) ||
        this.cleanText(container.find('img').first().attr('alt')) ||
        null;

      const image =
        link.find('img').first().attr('src') ||
        container.find('img').first().attr('src') ||
        null;

      if (!title && !image) {
        return;
      }

      if (title && this.isGarbageTitle(title)) {
        return;
      }

      booksMap.set(productUrl, {
        asin: this.extractAsinFromUrl(productUrl),
        url: productUrl,
        title,
        image,
      });
    });

    return Array.from(booksMap.values());
  }

  private normalizeAmazonProductUrl(href?: string): string | null {
    if (!href) {
      return null;
    }

    if (!href.includes('/dp/') && !href.includes('/gp/product/')) {
      return null;
    }

    try {
      const url = new URL(href, 'https://www.amazon.com');

      const dpMatch = url.pathname.match(/\/dp\/([A-Z0-9]{10})/);
      if (dpMatch) {
        return `https://www.amazon.com/dp/${dpMatch[1]}`;
      }

      const gpMatch = url.pathname.match(/\/gp\/product\/([A-Z0-9]{10})/);
      if (gpMatch) {
        return `https://www.amazon.com/dp/${gpMatch[1]}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  private extractAsinFromUrl(url: string): string | null {
    const match = url.match(/\/dp\/([A-Z0-9]{10})/);
    return match?.[1] ?? null;
  }

  private cleanText(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    const normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length ? normalized : null;
  }

  private isGarbageTitle(title: string): boolean {
    const lowerTitle = title.toLowerCase();

    return (
      lowerTitle === 'shop now' ||
      lowerTitle === 'buy now' ||
      lowerTitle === 'learn more' ||
      lowerTitle === 'change address' ||
      lowerTitle === 'dismiss'
    );
  }
}
