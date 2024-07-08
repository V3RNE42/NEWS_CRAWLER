import { parseISO, differenceInHours, parse } from 'date-fns';
import { es, enUS } from 'date-fns/locale';
import axios from 'axios';
import cheerio from 'cheerio';
import { URL } from 'url';
import sanitizeHtml from 'sanitize-html';
const MAX_RETRIES_PER_FETCH = 3;
const INITIAL_DELAY = 500;

// Custom rate limiter implementation
class RateLimiter {
    constructor(tokensPerInterval, interval) {
        this.tokensPerInterval = tokensPerInterval;
        this.interval = interval;
        this.tokens = tokensPerInterval;
        this.lastRefill = Date.now();
    }

    async removeTokens(count) {
        await this.refillTokens();
        if (this.tokens < count) {
            const waitTime = ((count - this.tokens) * this.interval) / this.tokensPerInterval;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            await this.refillTokens();
        }
        this.tokens -= count;
    }

    async refillTokens() {
        const now = Date.now();
        const elapsedTime = now - this.lastRefill;
        const refillAmount = (elapsedTime / this.interval) * this.tokensPerInterval;
        this.tokens = Math.min(this.tokensPerInterval, this.tokens + refillAmount);
        this.lastRefill = now;
    }
}

const rateLimiter = new RateLimiter(1, 1000); // 1 request per second


/** Calculate the relevance score and find the most common term in the given text.
 *
 * @param {string} text - The text to analyze.
 * @return {object} An object containing the score and the most common term.    */
const relevanceScoreAndMaxCommonFoundTerm = (text, terms) => {
    let score = 0, mostCommonTerm = "", maxCommonFoundTermCount = 0;
    for (const term of terms) {
        const regex = new RegExp("\\b" + term + "\\b", 'ig');
        const matches = text.match(regex) || [];
        const termCount = matches.length;
        if (termCount > 0) {
            score++;
            if (termCount > maxCommonFoundTermCount) {
                mostCommonTerm = term;
                maxCommonFoundTermCount = termCount;
            }
        }
    }
    return { score, mostCommonTerm };
};

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, retries = 0, initialDelay = INITIAL_DELAY) {
    try {
        const randomDelay = Math.floor(Math.random() * initialDelay);
        await sleep(randomDelay);
        await rateLimiter.removeTokens(1);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 15000
        });
        return response.data;
    } catch (error) {
        if (retries >= MAX_RETRIES_PER_FETCH) {
            throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES_PER_FETCH} retries: ${error.message}`);
        }
        const delay = initialDelay * Math.pow(5, retries) * 20;
        console.log(`Attempt ${retries + 1} failed for ${url}. Retrying in ${delay}ms...`);
        await sleep(delay);
        return fetchWithRetry(url, retries + 1, delay);
    }
}

/** Cleans the given text by removing HTML tags and trimming whitespace
 * @param {string} text - The text to be cleaned.
 * @return {string} The cleaned text.     */
const cleanText = (text) => {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: [] });
    while (text.includes("\n")) {
        text = text.replace(/\n/g, ' ');
    }
    while (text.includes("\t")) {
        text = text.replace(/\t/g, ' ');
    }
    while (text.includes('  ')) {
        text = text.replace(/'  '/g, ' ');
    }
    return text.replace(/<[^>]*>/g, ' ').trim();
}

/** Checks if the given fullLink is a valid URL for the baseUrl website.
 *
 * @param {string} baseUrl - The base URL of the website.
 * @param {string} fullLink - The full URL to be validated.
 * @return {boolean} Returns true if the fullLink is a valid URL for the baseUrl website, false otherwise.  */
function isWebsiteValid(baseUrl, fullLink) {
    try {
        const baseHostname = new URL(baseUrl).hostname;
        const linkHostname = new URL(fullLink).hostname;
        if (baseHostname === linkHostname) {
            return false; //because I don't want to add an article whose link is the website itself, without forward slashes '/' or anything
        }
        if (linkHostname.endsWith('.' + baseHostname) ||
            linkHostname.includes(baseHostname)) {
            return true; //I want to add articles WITHIN the website
        }
        return false;
    } catch (error) {
        console.warn(`Error comparing URLs: ${baseUrl} and ${fullLink}`);
        return false;
    }
}

function isRecent(dateText) {
    if (!dateText) return false;
    const now = new Date();
    let date;

    // Try parsing as ISO 8601 first
    date = parseISO(dateText);
    if (!isNaN(date)) {
        // Adjust for timezone if present
        const timezoneOffset = date.getTimezoneOffset() * 60000;
        date = new Date(date.getTime() - timezoneOffset);
        return differenceInHours(now, date) < 24;
    }

    // Try parsing the new format
    date = parse(dateText, 'dd/MM/yyyy HH:mm:ss xx', new Date());
    if (isValid(date)) {
        return differenceInHours(now, date) < 24;
    }

    // Handle relative dates
    const relativeMatchES = dateText.match(/hace (\d+) (minutos?|horas?|días?|semanas?|meses?)/i);
    const relativeMatchEN = dateText.match(/(\d+) (minute|hour|day|week|month)s? ago/i);
    if (relativeMatchES || relativeMatchEN) {
        const [_, amount, unit] = relativeMatchES || relativeMatchEN;
        date = new Date(now);
        switch (unit.toLowerCase()) {
            case 'minuto':
            case 'minutos':
            case 'minute':
            case 'minutes':
                date.setMinutes(date.getMinutes() - parseInt(amount));
                break;
            case 'hora':
            case 'horas':
            case 'hour':
            case 'hours':
                date.setHours(date.getHours() - parseInt(amount));
                break;
            case 'día':
            case 'días':
            case 'day':
            case 'days':
                date.setDate(date.getDate() - parseInt(amount));
                break;
            case 'semana':
            case 'semanas':
            case 'week':
            case 'weeks':
                date.setDate(date.getDate() - (parseInt(amount) * 7));
                break;
            case 'mes':
            case 'meses':
            case 'month':
            case 'months':
                date.setMonth(date.getMonth() - parseInt(amount));
                break;
        }
    } else {
        const formats = [
            'dd/MM/yyyy',
            'MM/dd/yyyy',
            'dd-MM-yyyy',
            'yyyy-MM-dd',
            'd MMMM yyyy',
            'MMMM d, yyyy',
            'd MMM yyyy',
            'MMM d, yyyy',
            "d 'de' MMMM 'de' yyyy",
            "d 'de' MMM'.' 'de' yyyy",
            'yyyy-MM-dd HH:mm:ss',
            "EEEE d 'de' MMMM", // For "Sábado 6 de Julio"
        ];

        for (const format of formats) {
            date = parse(dateText, format, new Date(), { locale: es });
            if (!isNaN(date)) break;
            date = parse(dateText, format, new Date(), { locale: enUS });
            if (!isNaN(date)) break;
        }

        if (isNaN(date)) {
            const spanishMonthAbbr = {
                'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
                'jul': 6, 'ago': 7, 'sept': 8, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
            };
            const match = dateText.match(/(\d{1,2})?\s*(?:de)?\s*(\w+)\.?\s*(?:de)?\s*(\d{4})?/i);
            if (match) {
                let [_, day, month, year] = match;
                month = spanishMonthAbbr[month.toLowerCase().substring(0, 3)];
                if (month !== undefined) {
                    year = year ? parseInt(year) : now.getFullYear();
                    day = day ? parseInt(day) : 1;
                    date = new Date(year, month, day);
                }
            }
        }

        if (isNaN(date)) {
            console.warn(`Could not parse date: ${dateText}`);
            return false;
        }
    }

    return differenceInHours(now, date) < 24;
}

async function crawlWebsite(url, terms, workerAddedLinks, cycleEndTime, maxDepth = 3) {
    const results = {};
    terms.forEach(term => results[term] = []);

    async function crawl(currentUrl, depth) {
        if (depth > maxDepth || workerAddedLinks.has(currentUrl) || Date.now() >= cycleEndTime.getTime()) {
            return;
        }

        workerAddedLinks.add(currentUrl);

        try {
            const html = await fetchWithRetry(currentUrl);
            const $ = cheerio.load(html);

            const title = $('h1').first().text() || $('title').text();
            const fullText = $('article, .article-body, .content, main').text() || $('body').text();
            const date = cleanText($('meta[property="article:published_time"]').attr('content') ||
                $('time').attr('datetime') ||
                $('.date, .published-date').first().text());

            const { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(title + ' ' + fullText, terms);

            if (score > 0 && isRecent(date) && isWebsiteValid(url, currentUrl)) {
                console.log(`+++ ADDED ARTICLE for term ${mostCommonTerm} - ${currentUrl}`);
                results[mostCommonTerm].push({
                    title: title,
                    link: currentUrl,
                    fullText: fullText,
                    date: date,
                    score: score,
                    summary: "placeholder",
                    term: mostCommonTerm
                });
            }

            const links = $('a')
                .map((i, link) => $(link).attr('href'))
                .get()
                .filter(href => href)
                .map(href => {
                    try {
                        if (href.startsWith('http://') || href.startsWith('https://')) {
                            return new URL(href).href;
                        } else {
                            return new URL(href, currentUrl).href;
                        }
                    } catch (e) {
                        console.log(`Invalid URL: ${href} on page ${currentUrl}`);
                        return null;
                    }
                })
                .filter(href => href && isWebsiteValid(url, href));

            for (const link of links) {
                if (!workerAddedLinks.has(link) && Date.now() < cycleEndTime.getTime()) {
                    await crawl(link, depth + 1);
                }
            }
        } catch (error) {
            console.error(`Error crawling ${currentUrl}: ${error.message}`);
        }
    }

    await crawl(url, 0);
    return results;
}

export { crawlWebsite };