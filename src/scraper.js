const axios = require("axios");
const cheerio = require("cheerio");

// Normalize whitespace artifacts from HTML (including non-breaking spaces).
function cleanText(value) {
  return (value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function parseRuDate(value) {
  const match = cleanText(value).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function parseRuDateTime(value) {
  const match = cleanText(value).match(
    /(\d{2})\.(\d{2})\.(\d{4})\s+в\s+(\d{2}):(\d{2})/
  );
  if (!match) return null;

  const [, dd, mm, yyyy, hh, min] = match;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00+06:00`;
}

function mapLimit(items, limit, iterator) {
  if (!Array.isArray(items) || items.length === 0) return Promise.resolve([]);

  const safeLimit = Math.max(1, limit);
  const result = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      result[index] = await iterator(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => worker());
  return Promise.all(workers).then(() => result);
}

/**
 * @typedef {Object} ScraperGroup
 * @property {string} code
 * @property {string} name
 * @property {string} href
 * @property {string} url
 */

/**
 * @typedef {Object} ScraperTeacher
 * @property {string} code
 * @property {string} name
 * @property {string} href
 * @property {string} url
 */

/**
 * @typedef {Object} ScraperLesson
 * @property {string} groupCode
 * @property {string} groupName
 * @property {string} date
 * @property {string|null} dayLabel
 * @property {number} lessonNumber
 * @property {number} columnIndex
 * @property {string} subject
 * @property {string|null} room
 * @property {string|null} teacher
 * @property {string} sourceUrl
 */

class OmAcademyScraper {
  /**
   * @param {{baseUrl: string, timeoutMs?: number, maxConcurrentRequests?: number}} options
   */
  constructor({ baseUrl, timeoutMs = 20000, maxConcurrentRequests = 5 }) {
    this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    this.timeoutMs = timeoutMs;
    this.maxConcurrentRequests = maxConcurrentRequests;
    this.http = axios.create({ timeout: this.timeoutMs });
  }

  /**
   * Build an absolute URL from a relative source path.
   *
   * @param {string} relativePath
   * @returns {string}
   */
  buildUrl(relativePath) {
    return new URL(relativePath, this.baseUrl).href;
  }

  /**
   * Fetch raw HTML from the source website with retry logic.
   *
   * @param {string} relativePath
   * @returns {Promise<{html: string, url: string}>}
   */
  async fetchHtml(relativePath) {
    const url = this.buildUrl(relativePath);
    let lastError = null;

    // Retry transient network failures to reduce sync instability.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await this.http.get(url);
        return { html: response.data, url };
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt === 3;
        if (isLastAttempt) break;
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }

    throw new Error(`Failed to fetch ${url}: ${lastError?.message || "unknown error"}`);
  }

  /**
   * Parse the source "last updated" timestamp from the page header.
   *
   * @param {import("cheerio").CheerioAPI} $
   * @returns {string|null}
   */
  extractSourceUpdatedAt($) {
    const refText = cleanText($("div.ref").first().text());
    return parseRuDateTime(refText);
  }

  /**
   * Parse all groups from `cg.htm`.
   *
   * @returns {Promise<{sourceUrl: string, sourceUpdatedAt: string|null, groups: ScraperGroup[]}>}
   */
  async fetchGroups() {
    const { html, url } = await this.fetchHtml("cg.htm");
    const $ = cheerio.load(html);

    const groups = [];
    // Group links on cg.htm are stored as anchors like cg238.htm.
    $("a.z0[href^='cg'][href$='.htm']").each((_, el) => {
      const href = $(el).attr("href");
      const name = cleanText($(el).text());
      if (!href || !name) return;

      const match = href.match(/^cg(\d+)\.htm$/i);
      if (!match) return;

      groups.push({
        code: match[1],
        name,
        href,
        url: this.buildUrl(href)
      });
    });

    return {
      sourceUrl: url,
      sourceUpdatedAt: this.extractSourceUpdatedAt($),
      groups
    };
  }

  /**
   * Parse all teachers from `cp.htm`.
   *
   * @returns {Promise<{sourceUrl: string, sourceUpdatedAt: string|null, teachers: ScraperTeacher[]}>}
   */
  async fetchTeachers() {
    const { html, url } = await this.fetchHtml("cp.htm");
    const $ = cheerio.load(html);

    const teachers = [];
    // Teacher links on cp.htm are stored as anchors like cp192.htm.
    $("a.z0[href^='cp'][href$='.htm']").each((_, el) => {
      const href = $(el).attr("href");
      const name = cleanText($(el).text());
      if (!href || !name) return;

      const match = href.match(/^cp(\d+)\.htm$/i);
      if (!match) return;

      teachers.push({
        code: match[1],
        name,
        href,
        url: this.buildUrl(href)
      });
    });

    return {
      sourceUrl: url,
      sourceUpdatedAt: this.extractSourceUpdatedAt($),
      teachers
    };
  }

  /**
   * Parse day/date metadata from the first table cell in a schedule row.
   *
   * @param {string} rawHtml
   * @returns {{date: string|null, dayLabel: string|null}}
   */
  parseDayCellHtml(rawHtml) {
    const normalized = (rawHtml || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ");

    const parts = normalized
      .split("\n")
      .map((part) => cleanText(part))
      .filter(Boolean);

    if (parts.length === 0) return { date: null, dayLabel: null };
    // Day rows look like: "13.02.2026<br>Пт-1".
    return {
      date: parseRuDate(parts[0]),
      dayLabel: parts[1] || null
    };
  }

  /**
   * Parse all lesson rows for a single group page (`cgXXX.htm`).
   *
   * @param {{code: string, name: string, href: string}} group
   * @returns {Promise<{group: ScraperGroup, lessons: ScraperLesson[]}>}
   */
  async fetchGroupLessons(group) {
    const { html, url } = await this.fetchHtml(group.href);
    const $ = cheerio.load(html);

    const title = cleanText($("h1").first().text());
    const titleMatch = title.match(/^Группа:\s*(.+)$/i);
    const pageGroupName = titleMatch ? cleanText(titleMatch[1]) : group.name;

    let currentDate = null;
    let currentDayLabel = null;
    const lessons = [];

    $("table.inf tr").each((_, tr) => {
      const cells = $(tr).find("td");
      if (!cells.length) return;

      let offset = 0;
      const firstCellHtml = $(cells[0]).html() || "";
      const parsed = this.parseDayCellHtml(firstCellHtml);
      if (parsed.date) {
        // Day value is carried by the first row and applies to following pair rows.
        currentDate = parsed.date;
        currentDayLabel = parsed.dayLabel;
        offset = 1;
      }

      const pairCell = cells[offset];
      if (!pairCell) return;
      const lessonNumber = Number.parseInt(cleanText($(pairCell).text()), 10);
      if (!Number.isFinite(lessonNumber)) return;

      const lessonCells = [];
      for (let i = offset + 1; i < cells.length; i += 1) {
        lessonCells.push(cells[i]);
      }

      lessonCells.forEach((lessonCell, idx) => {
        const td = $(lessonCell);
        // "nul" means an empty slot with no lesson data.
        if (td.hasClass("nul")) return;

        const subject = cleanText(td.find("a.z1").first().text());
        const room = cleanText(td.find("a.z2").first().text());
        const teacher = cleanText(td.find("a.z3").first().text());

        if (!subject || !currentDate) return;

        lessons.push({
          groupCode: group.code,
          groupName: pageGroupName,
          date: currentDate,
          dayLabel: currentDayLabel,
          lessonNumber,
          columnIndex: idx + 1,
          subject,
          room: room || null,
          teacher: teacher || null,
          sourceUrl: url
        });
      });
    });

    return {
      group: {
        ...group,
        name: pageGroupName
      },
      lessons
    };
  }

  /**
   * Parse lessons for all groups with bounded concurrency.
   *
   * @param {ScraperGroup[]} groups
   * @returns {Promise<{groups: ScraperGroup[], lessons: ScraperLesson[]}>}
   */
  async fetchAllLessons(groups) {
    const chunks = await mapLimit(
      groups,
      this.maxConcurrentRequests,
      async (group) => this.fetchGroupLessons(group)
    );

    const normalizedGroups = [];
    const lessons = [];

    chunks.forEach((chunk) => {
      normalizedGroups.push(chunk.group);
      lessons.push(...chunk.lessons);
    });

    return { groups: normalizedGroups, lessons };
  }
}

module.exports = { OmAcademyScraper };
