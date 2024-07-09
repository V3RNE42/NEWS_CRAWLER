import { parseISO, parse, differenceInHours, isValid, addMinutes, addHours } from 'date-fns';
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

    // Check if the input is a Unix timestamp
    if (/^\d+$/.test(dateText)) {
        const timestamp = parseInt(dateText, 10);
        if (timestamp > 0) {
            date = new Date(timestamp * 1000);
            return differenceInHours(now, date) < 24;
        }
    }

    // Try parsing as ISO 8601 first
    date = parseISO(dateText);
    if (!isNaN(date)) {
        return differenceInHours(now, date) < 24;
    }

    // Handle "YYYY-MM-DD[TIMEZONE]HH:MM:SS" format
    const tzAbbrMatch = dateText.match(/(\d{4}-\d{2}-\d{2})([A-Z]{3})(\d{2}:\d{2}:\d{2})/);
    if (tzAbbrMatch) {
        const [_, datePart, tz, timePart] = tzAbbrMatch;
        const combinedDate = `${datePart}T${timePart}`;
        const offsetMap = {
            'ACDT': 10.5, 'ACST': 9.5, 'ACT': -5, 'ACWST': 8.75, 'ADT': -3, 'AEDT': 11,
            'AEST': 10, 'AET': 10, 'AFT': 4.5, 'AKDT': -8, 'AKST': -9, 'ALMT': 6,
            'AMST': -3, 'AMT': -4, 'ANAT': 12, 'AQTT': 5, 'ART': -3, 'AST': -4,
            'AWST': 8, 'AZOST': 0, 'AZOT': -1, 'AZT': 4, 'BDT': 8, 'BIOT': 6,
            'BIT': -12, 'BOT': -4, 'BRST': -2, 'BRT': -3, 'BST': 1, 'BTT': 6,
            'CAT': 2, 'CCT': 6.5, 'CDT': -5, 'CEST': 2, 'CET': 1, 'CHADT': 13.75,
            'CHAST': 12.75, 'CHOT': 8, 'CHOST': 9, 'CHST': 10, 'CHUT': 10, 'CIST': -8,
            'CIT': 8, 'CKT': -10, 'CLST': -3, 'CLT': -4, 'COST': -4, 'COT': -5,
            'CST': -6, 'CT': 8, 'CVT': -1, 'CWST': 8.75, 'CXT': 7, 'DAVT': 7,
            'DDUT': 10, 'DFT': 1, 'EASST': -5, 'EAST': -6, 'EAT': 3, 'ECT': -5,
            'EDT': -4, 'EEST': 3, 'EET': 2, 'EGST': 0, 'EGT': -1, 'EST': -5,
            'ET': -5, 'FET': 3, 'FJT': 12, 'FKST': -3, 'FKT': -4, 'FNT': -2,
            'GALT': -6, 'GAMT': -9, 'GET': 4, 'GFT': -3, 'GILT': 12, 'GMT': 0,
            'GST': 4, 'GYT': -4, 'HDT': -9, 'HAEC': 2, 'HST': -10, 'HKT': 8,
            'HMT': 5, 'HOVT': 7, 'ICT': 7, 'IDLW': -12, 'IDT': 3, 'IOT': 6,
            'IRDT': 4.5, 'IRKT': 8, 'IRST': 3.5, 'IST': 5.5, 'JST': 9, 'KALT': 2,
            'KGT': 6, 'KOST': 11, 'KRAT': 7, 'KST': 9, 'LHST': 10.5, 'LINT': 14,
            'MAGT': 12, 'MART': -9.5, 'MAWT': 5, 'MDT': -6, 'MET': 1, 'MEST': 2,
            'MHT': 12, 'MIST': 11, 'MIT': -9.5, 'MMT': 6.5, 'MSK': 3, 'MST': -7,
            'MUT': 4, 'MVT': 5, 'MYT': 8, 'NCT': 11, 'NDT': -2.5, 'NFT': 11,
            'NOVT': 7, 'NPT': 5.75, 'NST': -3.5, 'NT': -3.5, 'NUT': -11, 'NZDT': 13,
            'NZST': 12, 'OMST': 6, 'ORAT': 5, 'PDT': -7, 'PET': -5, 'PETT': 12,
            'PGT': 10, 'PHOT': 13, 'PHT': 8, 'PKT': 5, 'PMDT': -2, 'PMST': -3,
            'PONT': 11, 'PST': -8, 'PWT': 9, 'PYST': -3, 'PYT': -4, 'RET': 4,
            'ROTT': -3, 'SAKT': 11, 'SAMT': 4, 'SAST': 2, 'SBT': 11, 'SCT': 4,
            'SDT': -10, 'SGT': 8, 'SLST': 5.5, 'SRET': 11, 'SRT': -3, 'SST': 8,
            'SYOT': 3, 'TAHT': -10, 'THA': 7, 'TFT': 5, 'TJT': 5, 'TKT': 13,
            'TLT': 9, 'TMT': 5, 'TRT': 3, 'TOT': 13, 'TVT': 12, 'ULAST': 9,
            'ULAT': 8, 'USZ1': 2, 'UTC': 0, 'UYST': -2, 'UYT': -3, 'UZT': 5,
            'VET': -4, 'VLAT': 10, 'VOLT': 4, 'VOST': 6, 'VUT': 11, 'WAKT': 12,
            'WAST': 2, 'WAT': 1, 'WEST': 1, 'WET': 0, 'WIT': 7, 'WGST': -2,
            'WGT': -3, 'WST': 8, 'YAKT': 9, 'YEKT': 5
        };
        const offset = offsetMap[tz] || 0;
        date = parse(combinedDate, "yyyy-MM-dd'T'HH:mm:ss", new Date());
        if (isValid(date)) {
            date = addHours(date, offset);
            return differenceInHours(now, date) < 24;
        }
    }

    // Handle "dd/MM/yyyy HH:mm" format
    date = parse(dateText, 'dd/MM/yyyy HH:mm', new Date());
    if (isValid(date)) {
        return differenceInHours(now, date) < 24;
    }

    // Handle "dd-MM-yyyy HH:mm:ss" format
    date = parse(dateText, 'dd-MM-yyyy HH:mm:ss', new Date());
    if (isValid(date)) {
        return differenceInHours(now, date) < 24;
    }

    // Handle preamble like "By Lucas Leiroz de Almeida, July 08, 2024"
    const preambleMatch = dateText.match(/.*, (\w+ \d{2}, \d{4})/);
    if (preambleMatch) {
        const [_, datePart] = preambleMatch;
        date = parse(datePart, 'MMMM dd, yyyy', new Date(), { locale: enUS });
        if (isValid(date)) {
            return differenceInHours(now, date) < 24;
        }
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
        return differenceInHours(now, date) < 24;
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
            if (isValid(date)) break;
            date = parse(dateText, format, new Date(), { locale: enUS });
            if (isValid(date)) break;
        }

        if (!isValid(date)) {
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
                    return differenceInHours(now, date) < 24;
                }
            }
        }

        // Handle natural language dates like "Panamá, 09 de julio del 2024"
        const nlMatch = dateText.match(/(\d{1,2})\s*de\s*(\w+)\s*del?\s*(\d{4})/i);
        if (nlMatch) {
            let [_, day, month, year] = nlMatch;
            const spanishMonthFull = {
                'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
                'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
            };
            month = spanishMonthFull[month.toLowerCase()];
            if (month !== undefined) {
                date = new Date(parseInt(year), month, parseInt(day));
                return differenceInHours(now, date) < 24;
            }
        }

        if (!isValid(date)) {
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
            return results;
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
                        const subResults = await crawl(link, depth + 1);
                        for (const [term, articles] of Object.entries(subResults)) {
                            if (!results[term]) results[term] = [];
                            results[term].push(...articles);
                        }
                    }
                }
        } catch (error) {
            console.error(`Error crawling ${currentUrl}: ${error.message}`);
        }
    }

    try {
        await crawl(url, 0);
    } catch (error) {
        console.error(`Error in crawlWebsite for ${url}: ${error.message}`);
    }

    console.log(`Finished crawling ${url}. Found ${Object.values(results).flat().length} articles.`);
    return results;
}

export { crawlWebsite };