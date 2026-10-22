/**
 * Output schemas (zod raw shapes) for every tool. They mirror the objects the
 * handlers build and are declared as `outputSchema`, so clients can validate
 * `structuredContent` instead of re-parsing text. Fields derived from the
 * site's JSON-LD are optional, so sparse live markup never fails validation.
 */

import { z } from "zod";

const catalogItem = z.object({
  slug: z.string(),
  label: z.string(),
  url: z.string(),
  description: z.string().optional(),
});

/** Present only when include_descriptions was true. */
const enrichFields = {
  descriptions_unavailable: z
    .number()
    .int()
    .optional()
    .describe("How many descriptions could not be fetched (only with include_descriptions)."),
  note: z.string().optional(),
};

export const statusOutput = {
  reachable: z.boolean(),
  status: z.number().int(),
  url: z.string(),
  response_time_ms: z.number(),
  checked_at: z.string(),
};

export const websiteInfoOutput = {
  product: z.object({
    name: z.string(),
    description: z.string().optional(),
    applicationCategory: z.string().optional(),
    applicationSubCategory: z.string().optional(),
    operatingSystem: z.string().optional(),
  }),
  organization: z.object({
    name: z.string().optional(),
    url: z.string().optional(),
    email: z.string().optional(),
    description: z.string().optional(),
    logo: z.string().optional(),
  }),
  markets: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      currency: z.string(),
      url: z.string(),
    }),
  ),
  source_url: z.string(),
};

export const contactOutput = {
  general_email: z.string().nullable(),
  contact_points: z.array(
    z.object({
      type: z.string(),
      email: z.string().nullable(),
      telephone: z.string().nullable(),
    }),
  ),
  contact_page: z.string(),
  demo_page: z.string(),
};

export const getStartedOutput = {
  market: z.string(),
  demo_url: z.string(),
  contact_url: z.string(),
  pricing_url: z.string(),
  signup_url: z.string().nullable(),
  note: z.string(),
  call_to_action: z.string(),
};

export const pricingOutput = {
  market: z.string(),
  currency: z.string(),
  plans: z.array(
    z.object({
      plan: z.string(),
      billing: z.string(),
      price: z.number(),
      currency: z.string(),
      unit: z.string(),
      minUsers: z.number().optional(),
      maxUsers: z.number().optional(),
      url: z.string().optional(),
    }),
  ),
  trial_terms: z
    .object({ text: z.string(), source: z.enum(["json-ld", "faq"]) })
    .nullable()
    .describe("Free-trial terms as the page's structured data states them, or null."),
  source_url: z.string(),
};

export const listPagesOutput = {
  market: z.string(),
  count: z.number().int(),
  catalog_source: z
    .enum(["sitemap", "snapshot"])
    .describe("Whether the page list comes from the live sitemap or the verified snapshot."),
  catalog_fetched_at: z.string().nullable(),
  pages: z.array(
    z.object({
      path: z.string(),
      url: z.string(),
      type: z.string(),
      market: z.string().nullable(),
    }),
  ),
};

export const pageContentOutput = {
  url: z.string(),
  type: z.string(),
  title: z.string(),
  description: z.string(),
  canonical: z.string().nullable(),
  headings: z.array(z.object({ level: z.number().int(), text: z.string() })),
  text: z.string(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
  links: z.array(z.object({ text: z.string(), url: z.string() })),
};

export const searchOutput = {
  query: z.string(),
  market: z.string(),
  pages_searched: z.number().int(),
  pages_failed: z.number().int(),
  count: z.number().int(),
  note: z.string().optional(),
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      type: z.string(),
      score: z.number(),
      snippet: z.string(),
    }),
  ),
};

export const featuresOutput = {
  market: z.string(),
  count: z.number().int(),
  features: z.array(catalogItem),
  ...enrichFields,
};

export const solutionsOutput = {
  market: z.string(),
  count: z.number().int(),
  solutions: z.array(catalogItem),
  ...enrichFields,
};

export const resourcesOutput = {
  market: z.string(),
  landing_pages: z.object({
    resources: z.string(),
    blog: z.string(),
    guides: z.string(),
    help: z.string(),
  }),
  count: z.number().int(),
  articles: z.array(catalogItem),
  ...enrichFields,
};

export const limitsOutput = {
  not_built: z.array(z.object({ item: z.string(), reason: z.string().optional() })),
  known_limits: z.array(z.string()),
  inventory_checked_on: z
    .string()
    .optional()
    .describe("Date (YYYY-MM-DD) the site says its feature inventory was last checked."),
  source_url: z.string(),
};
