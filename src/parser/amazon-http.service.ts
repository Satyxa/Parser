import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class AmazonHttpService {
  private readonly logger = new Logger(AmazonHttpService.name);
  private readonly client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      timeout: 20_000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        dnt: '1',
        'upgrade-insecure-requests': '1',
      },
    });
  }

  async getHtml(url: string, referer?: string): Promise<string> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.client.get<string>(url, {
          headers: referer ? { referer } : undefined,
        });

        const html = typeof response.data === 'string' ? response.data : '';

        if (response.status >= 400) {
          const reason = this.detectBlockReason(html);
          throw new Error(
            `HTTP ${response.status}${reason ? ` (${reason})` : ''}`,
          );
        }

        if (!html.trim()) {
          throw new Error('Empty HTML response');
        }

        const blockReason = this.detectBlockReason(html);
        if (blockReason) {
          throw new Error(`Blocked by Amazon (${blockReason})`);
        }

        return html;
      } catch (error) {
        lastError = error;

        this.logger.warn(
          `Request failed (${attempt}/${maxAttempts}) for ${url}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        if (attempt < maxAttempts) {
          await this.sleep(800 * attempt);
        }
      }
    }

    throw new Error(
      `Failed to fetch ${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private detectBlockReason(html: string): string | null {
    const normalized = html.toLowerCase();

    if (normalized.includes('captcha')) return 'captcha';
    if (normalized.includes('type the characters you see in this image'))
      return 'captcha';
    if (
      normalized.includes("sorry, we just need to make sure you're not a robot")
    )
      return 'robot-check';
    if (normalized.includes('automated access to amazon data'))
      return 'automated-access-detected';

    return null;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
