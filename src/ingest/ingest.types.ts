export type DatabaseId = number | string;
export type CandidateStatus = 'pending' | 'enriched' | 'approved' | 'rejected' | 'published' | 'failed';

export interface FeedSource {
  sourceKey: string;
  name: string;
  feedUrl: string;
  homepageUrl: string;
  feedType: string;
  dailyLimit: number;
  trustScore: number;
  contentMode: string;
  licenseCode: string;
  enabled: boolean;
}

export interface FeedEntry {
  externalId?: string;
  url: string;
  title: string;
  summary?: string;
  author?: string;
  publishedAt?: string | null;
  raw?: object;
}

export interface NewCandidate {
  sourceKey: string;
  externalId: string;
  canonicalUrl: string;
  titleOriginal: string;
  summaryOriginal: string;
  authorOriginal: string;
  sourcePublishedAt: string;
  contentMode: string;
  licenseCode: string;
  rawPayload: object;
  contentHash: string | null;
  score: number;
}

export interface Candidate {
  id: DatabaseId;
  canonicalUrl: string;
  titleOriginal: string;
  titleZh: string | null;
  summaryOriginal: string | null;
  summaryZh: string | null;
  recommendation: string | null;
  sourceId: DatabaseId;
  sourceName: string;
  sourcePublishedAt: string | Date | null;
  contentMode: string;
  licenseCode: string;
  content: unknown;
  score: number;
  status: CandidateStatus;
}

export interface ArticleSection {
  heading: string;
  paragraphs: string[];
}

export interface ImageCandidate {
  url: string;
  alt?: string | null;
  caption?: string | null;
  isCover?: boolean;
}

export interface ExtractedArticle {
  title: string;
  canonicalUrl: string;
  byline: string | null;
  publishedAt: string | null;
  textContent: string;
  sections: ArticleSection[];
  images: ImageCandidate[];
}

export interface ArticleSource {
  name: string;
  canonicalUrl: string;
  publishedAt?: string | Date | null;
}

export interface ArticleImage {
  id: DatabaseId;
  src: string;
  alt?: string;
  caption?: string;
  isCover?: boolean;
}

export type ArticleMark = {
  type: 'link';
  attrs: { href: string; target: string; rel: string };
};

export type ArticleTextNode = { type: 'text'; text: string; marks?: ArticleMark[] };
