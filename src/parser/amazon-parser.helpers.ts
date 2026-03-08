import { createHash } from 'node:crypto';
import { AvailabilityStatus, JsonValue, SellerType } from './parser.types';

export class AmazonParserHelpers {
  static clean(value?: string | null): string | null {
    if (!value) return null;
    const cleaned = value.replace(/\s+/g, ' ').trim();
    return cleaned || null;
  }

  static firstNonEmpty(
    ...values: Array<string | null | undefined>
  ): string | null {
    for (const value of values) {
      const cleaned = this.clean(value);
      if (cleaned) return cleaned;
    }

    return null;
  }

  static normalizeAsin(value?: string | null): string | null {
    if (!value) return null;
    const normalized = value.trim().toUpperCase();
    return /^[A-Z0-9]{10}$/.test(normalized) ? normalized : null;
  }

  static extractAsinFromUrl(url: string): string | null {
    const match = url.match(
      /\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})(?:[/?]|$)/i,
    );
    return match?.[1]?.toUpperCase() ?? null;
  }

  static toAbsoluteUrl(href: string, base: string): string | null {
    try {
      return new URL(href, base).toString();
    } catch {
      return null;
    }
  }

  static normalizeImage(value?: string | null): string | null {
    if (!value) return null;

    const cleaned = value.trim();
    if (!cleaned) return null;
    if (cleaned.startsWith('data:')) return null;

    return cleaned;
  }

  static isRealImageUrl(value?: string | null): value is string {
    if (!value) return false;

    return (
      !/grey-pixel/i.test(value) &&
      !/play-icon-overlay/i.test(value) &&
      !/sprite/i.test(value)
    );
  }

  static parsePrice(text: string | null): number | null {
    if (!text) return null;

    const normalized = text.replace(/[^0-9.,]/g, '').replace(/,/g, '');
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
  }

  static parsePriceRange(
    text: string | null,
  ): { min: number | null; max: number | null } | null {
    if (!text) return null;

    const normalized = text.replace(/\s+/g, ' ').trim();
    const match = normalized.match(
      /([£$€¥]\s*[\d,.]+|[\d,.]+\s*[£$€¥]?)[\s]*(?:-|–|to)[\s]*([£$€¥]\s*[\d,.]+|[\d,.]+\s*[£$€¥]?)/i,
    );

    if (!match) {
      return null;
    }

    const min = this.parsePrice(match[1] ?? null);
    const max = this.parsePrice(match[2] ?? null);

    if (min == null && max == null) {
      return null;
    }

    return {
      min,
      max,
    };
  }

  static parseCouponAmount(text: string | null): number | null {
    if (!text) return null;

    const amountMatch = text.match(/([£$€¥])\s*([\d,.]+)/);
    if (!amountMatch) {
      return null;
    }

    return this.parsePrice(`${amountMatch[1]}${amountMatch[2]}`);
  }

  static parseCouponPercent(text: string | null): number | null {
    if (!text) return null;

    const match = text.match(/(\d{1,3})\s*%/);
    if (!match) {
      return null;
    }

    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  static parseNumberLike(text: string | null): number | null {
    if (!text) return null;

    const normalized = text.replace(',', '.').replace(/[^\d.]/g, '');
    const parsed = Number(normalized);

    return Number.isFinite(parsed) ? parsed : null;
  }

  static parseRating(text: string | null): number | null {
    if (!text) return null;

    const match = text.match(/([0-9]+(?:[.,][0-9]+)?)/);
    if (!match) return null;

    const parsed = Number(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  static parseInteger(text: string | null): number | null {
    if (!text) return null;

    if (/one\b/i.test(text)) return 1;

    const match = text.match(/([\d,.]+)/);
    if (!match) return null;

    const parsed = Number(
      match[1].replace(/[,.](?=\d{3}\b)/g, '').replace(/,/g, ''),
    );

    return Number.isFinite(parsed) ? parsed : null;
  }

  static parseHelpfulVotes(text: string | null): number | null {
    if (!text) return null;
    if (/one person found this helpful/i.test(text)) return 1;
    return this.parseInteger(text);
  }

  static detectCurrencyCode(text: string | null): string | null {
    if (!text) return null;

    const normalized = text.toUpperCase();

    if (/\bUSD\b/.test(normalized) || text.includes('$')) return 'USD';
    if (/\bEUR\b/.test(normalized) || text.includes('€')) return 'EUR';
    if (/\bGBP\b/.test(normalized) || text.includes('£')) return 'GBP';
    if (/\bJPY\b/.test(normalized) || text.includes('¥')) return 'JPY';

    return null;
  }

  static stripAmazonReadMore(text: string | null): string | null {
    if (!text) return null;

    return this.clean(
      text.replace(/\bRead more\b\s*$/i, '').replace(/\bReport\b\s*$/i, ''),
    );
  }

  static toAvailabilityStatus(text: string | null): AvailabilityStatus {
    if (!text) return 'UNKNOWN';

    const value = text.toLowerCase();

    if (
      value.includes('currently unavailable') ||
      value.includes('out of stock') ||
      value.includes('temporarily out of stock') ||
      value.includes('unavailable')
    ) {
      return 'OUT_OF_STOCK';
    }

    if (value.includes('in stock') || value.includes('available')) {
      return 'IN_STOCK';
    }

    return 'UNKNOWN';
  }

  static availabilityFromJsonLd(text: string | null): AvailabilityStatus {
    if (!text) return 'UNKNOWN';

    const value = text.toLowerCase();

    if (value.includes('instock')) return 'IN_STOCK';
    if (value.includes('outofstock')) return 'OUT_OF_STOCK';

    return 'UNKNOWN';
  }

  static parseReviewDate(text: string | null): Date | null {
    if (!text) return null;

    const normalized = this.clean(text);
    if (!normalized) return null;

    const match = normalized.match(/\bon\s+(.+)$/i);
    const datePart = match?.[1] ?? normalized;

    const parsed = new Date(datePart);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  static decodeEscapedHtml(value: string): string {
    return value
      .replace(/\\u002F/g, '/')
      .replace(/\\\//g, '/')
      .replace(/&quot;/g, '"')
      .replace(/&#x2F;/g, '/')
      .replace(/&#47;/g, '/')
      .replace(/\\"/g, '"');
  }

  static safeJsonParse(value: string): JsonValue {
    try {
      return JSON.parse(value.trim()) as JsonValue;
    } catch {
      return null;
    }
  }

  static getJsonLdString(value: JsonValue): string | null {
    if (value == null) return null;
    if (typeof value === 'string') return this.clean(value);
    if (typeof value === 'number') return String(value);
    return null;
  }

  static extractAmazonNodeId(url: string): string | null {
    try {
      const parsed = new URL(url);

      const bbn = parsed.searchParams.get('bbn');
      if (bbn && /^\d+$/.test(bbn)) {
        return bbn;
      }

      const rh = parsed.searchParams.get('rh');
      if (rh) {
        const decoded = decodeURIComponent(rh);
        const matches = [...decoded.matchAll(/n:(\d+)/g)];
        const last = matches.at(-1)?.[1] ?? null;
        if (last) return last;
      }

      return null;
    } catch {
      return null;
    }
  }

  static normalizeAuthor(value?: string | null): string | null {
    if (!value) return null;

    const cleaned = this.clean(
      value
        .replace(/^by\s+/i, '')
        .replace(
          /\((author|authors?|editor|editors|illustrator|illustrators)\)/gi,
          '',
        )
        .replace(/^visit the\s+/i, '')
        .replace(/\s+store$/i, ''),
    );

    if (!cleaned) {
      return null;
    }

    return this.collapseRepeatedChunk(cleaned);
  }

  static normalizeSeller(value?: string | null): string | null {
    if (!value) return null;

    const cleaned = this.clean(
      value
        .replace(/^ships from and sold by\s+/i, '')
        .replace(/^sold by\s+/i, '')
        .replace(/^ships from\s+/i, '')
        .replace(/^from\s+/i, '')
        .replace(/^store name:\s*/i, '')
        .replace(/\.$/, ''),
    );

    if (!cleaned) return null;

    return this.collapseRepeatedChunk(cleaned);
  }

  static normalizeExternalId(value?: string | null): string | null {
    if (!value) {
      return null;
    }

    const decoded = decodeURIComponent(value).trim();

    if (!decoded) {
      return null;
    }

    if (decoded.length > 64) {
      return null;
    }

    if (!/^[A-Za-z0-9._:=~-]+$/.test(decoded)) {
      return null;
    }

    return decoded;
  }

  static buildEntityId(
    type: SellerType,
    rawId?: string | null,
    label?: string | null,
  ): string | null {
    const normalizedRawId = this.normalizeExternalId(rawId);
    if (normalizedRawId) {
      return normalizedRawId;
    }

    const normalizedLabel = this.clean(label);
    if (!normalizedLabel) {
      return null;
    }

    return `${type}:${this.sha256(normalizedLabel.toLowerCase()).slice(0, 24)}`;
  }

  static collapseRepeatedChunk(value: string): string {
    const cleaned = this.clean(value);
    if (!cleaned) return value;

    for (let size = 1; size <= Math.floor(cleaned.length / 2); size++) {
      if (cleaned.length % size !== 0) continue;

      const chunk = cleaned.slice(0, size);
      if (chunk.repeat(cleaned.length / size) === cleaned) {
        return this.clean(chunk) ?? cleaned;
      }
    }

    return cleaned;
  }

  static sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  static dedupeStrings(values: Array<string | null | undefined>): string[] {
    return Array.from(
      new Set(
        values
          .map((item) => this.clean(item))
          .filter((item): item is string => Boolean(item)),
      ),
    );
  }
}
