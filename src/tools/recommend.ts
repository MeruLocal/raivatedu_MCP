/**
 * Tool: find_page_for_need — map an education-workflow question to the
 * RaivatEdu page that owns it.
 *
 * Deterministic keyword routing (no model call, no invented content). Each
 * rule names pages that exist on the site; a rule's pages are returned only if
 * they are in the current page catalog for the market. Nothing here states a
 * capability: it only says which page to read, and flags when the question
 * touches something the site lists as not built so the caller checks
 * raivatedu_get_limits first.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../context.js";
import { MARKETS, SITE_ORIGIN, type Market } from "../config.js";
import { lookupPath } from "../utils/url.js";
import { withUtm } from "../utils/utm.js";
import { buildResult, marketField, responseFormatField } from "./shared.js";
import { findPageOutput } from "./schemas.js";

interface Rule {
  topic: string;
  /** Matches against the lower-cased question. */
  pattern: RegExp;
  /** Market-relative paths, most specific first. */
  paths: string[];
}

export const RULES: readonly Rule[] = [
  {
    topic: "School management software / school ERP",
    pattern: /\b(school (management|erp|software)|erp for school|school administration)\b/,
    paths: ["school-management-software", "solutions/schools"],
  },
  {
    topic: "Admissions, enquiries and enrolment",
    pattern: /\b(admission|enquir|inquir|enrol|enroll|lead|applicant|application)/,
    paths: ["admission-management-software", "features/admissions", "features/enrolment-and-renewals"],
  },
  {
    topic: "Student records / student management system",
    pattern: /\b(student (management|record|information|data|profile)|sis\b|student database|batch)/,
    paths: ["student-management-system", "features/students-and-batches"],
  },
  {
    topic: "Fees, instalments and receipts",
    pattern: /\b(fee|fees|instal|installment|receipt|dues|collection)\b/,
    paths: ["features/fee-management"],
  },
  {
    topic: "Attendance",
    pattern: /\battendance\b/,
    paths: ["attendance-management-system", "features/attendance"],
  },
  {
    topic: "Education CRM for colleges and universities",
    pattern: /\b(crm|college|university|universities|higher education|recruitment)\b/,
    paths: ["solutions/colleges-universities", "features/communication"],
  },
  {
    topic: "Coaching and tuition institutes",
    pattern: /\b(coaching|tuition|institute|test prep|centre|center)\b/,
    paths: ["solutions/coaching-institutes"],
  },
  {
    topic: "Training providers and edtech",
    pattern: /\b(training|edtech|rto|vocational|course provider)\b/,
    paths: ["solutions/training-edtech"],
  },
  {
    topic: "Certificates",
    pattern: /\bcertificate/,
    paths: ["features/certificates"],
  },
  {
    topic: "WhatsApp, SMS and email communication",
    pattern: /\b(whatsapp|sms|email|follow[- ]?up|communicat|message)/,
    paths: ["features/communication", "resources/whatsapp-templates-for-admissions", "resources/first-response-time-admissions"],
  },
  {
    topic: "Moving off spreadsheets",
    pattern: /\b(spreadsheet|excel|google sheet|migrat|import)/,
    paths: ["resources/migrating-from-spreadsheets"],
  },
  {
    topic: "Reports and KPIs",
    pattern: /\b(report|kpi|dashboard|analytics|funnel|metric)/,
    paths: ["features/reports", "resources/admissions-funnel-metrics"],
  },
  {
    topic: "Pricing and plans",
    pattern: /\b(price|pricing|cost|plan|plans|how much|per user)\b/,
    paths: ["pricing"],
  },
  {
    topic: "Security and access control",
    pattern: /\b(security|role|permission|access control|audit|privacy|data protection)\b/,
    paths: ["features/platform-and-security", "security"],
  },
  {
    topic: "Counsellor productivity",
    pattern: /\b(counsellor|counselor|telecaller|admissions team)\b/,
    paths: ["resources/counsellor-productivity-without-micromanaging"],
  },
  {
    topic: "Education vocabulary (full forms and meanings)",
    pattern: /\b(full form|meaning of|what is a|what does .* stand for|glossary)\b/,
    paths: ["glossary"],
  },
];

/** Phrases the site lists under "Not built" (see raivatedu_get_limits). */
const NOT_BUILT_HINTS =
  /\b(parent (portal|app|login)|guardian portal|exam|marks|grading|gradebook|report card|teacher (login|portal)|absence alert|certificate verif|pdf receipt|receipt pdf|downloadable receipt|commission|incentive)/;

export function matchRules(question: string): Rule[] {
  const q = question.toLowerCase();
  return RULES.filter((r) => r.pattern.test(q));
}

export function registerRecommendTools(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "raivatedu_find_page_for_need",
    {
      title: "Find the RaivatEdu Page for a Need",
      description: `Given a school, college, coaching-institute or training-provider question about admissions, enquiries, student records, fees, attendance, certificates, WhatsApp/SMS follow-up, reports or pricing, return the RaivatEdu page that covers it, as canonical URLs to read or cite.

Use this first when a user asks things like "software to manage admissions and enquiries for a coaching institute", "school fee management software", "student management system for a college" or "what does an education CRM do". Then call raivatedu_get_page_content on a returned path for the page text, and raivatedu_get_limits if the question is about a capability that may not exist (parent portal, exams, report cards).

Args:
  - need (string, required): the question or need in plain words, 3-300 characters.
  - market (optional): locale (${MARKETS.join(", ")}); defaults to the configured market.

Returns matched topics with page URLs, and a flag if the question touches something the site lists as not built. If nothing matches, it returns the features and solutions index pages instead.`,
      inputSchema: {
        need: z
          .string()
          .min(3, "Describe the need in a few words.")
          .max(300)
          .describe("The question or need in plain words, e.g. 'fee management for a coaching institute'."),
        market: marketField,
        response_format: responseFormatField,
      },
      outputSchema: findPageOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ need, market }) => {
      const m: Market = market ?? ctx.config.defaultMarket;
      const tool = "raivatedu_find_page_for_need";
      const toUrl = (rel: string) => {
        const path = `/${m}/${rel}`;
        return lookupPath(path) ? withUtm(`${SITE_ORIGIN}${path}`, tool) : null;
      };

      const matches = matchRules(need)
        .map((r) => ({
          topic: r.topic,
          pages: r.paths
            .map((rel) => ({ path: `/${m}/${rel}`, url: toUrl(rel) }))
            .filter((p): p is { path: string; url: string } => p.url !== null),
        }))
        .filter((x) => x.pages.length > 0);

      const fallback =
        matches.length === 0
          ? ["features", "solutions"]
              .map((rel) => ({ path: `/${m}/${rel}`, url: toUrl(rel) }))
              .filter((p): p is { path: string; url: string } => p.url !== null)
          : [];

      const structured = {
        market: m,
        need,
        matches,
        fallback_pages: fallback,
        check_limits_first: NOT_BUILT_HINTS.test(need.toLowerCase()),
      };

      const lines = [`# RaivatEdu pages for: ${need}`, ""];
      for (const x of matches) {
        lines.push(`## ${x.topic}`, ...x.pages.map((p) => `- ${p.url}`), "");
      }
      if (matches.length === 0) {
        lines.push(
          "No specific topic matched. Start from the overview pages:",
          ...fallback.map((p) => `- ${p.url}`),
          "",
        );
      }
      if (structured.check_limits_first) {
        lines.push(
          "_This touches something RaivatEdu may not offer. Call raivatedu_get_limits before saying it does._",
        );
      }
      return buildResult(lines.join("\n").trim(), structured);
    },
  );
}
