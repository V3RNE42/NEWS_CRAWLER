//MODULES AND IMPORTS
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio');
const { decode } = require('html-entities');
const { XMLParser } = require('fast-xml-parser');
const axios = require("axios");
const { OpenAI } = require("openai");
const puppeteer = require('puppeteer');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { RateLimiter } = require('limiter');
const os = require('os');
const { parseISO, parse, differenceInHours, isValid, subMinutes } = require('date-fns');
const { es, enUS } = require('date-fns/locale');
let { terms, websites } = require("./terminos");
const config = require("./config.json");
const { getMainTopics, sanitizeHtml } = require("./text_analysis/topics_extractor");
const { coveringSameNews } = require("./text_analysis/natural_processing");
const { findValidChromiumPath } = require("./browser/browserPath");

//IMPORTANT CONSTANTS AND SETTINGS
const openai = new OpenAI({ apiKey: config.openai.api_key });
const LANGUAGE = config.text_analysis.language;
const SENSITIVITY = config.text_analysis.topic_sensitivity;
const MAX_TOKENS_PER_CALL = config.openai.max_tokens_per_call;
const SIMILARITY_THRESHOLD = config.text_analysis.max_similarity;
const IGNORE_REDUNDANCY = config.text_analysis.ignore_redundancy;
const MAX_RETRIES_PER_FETCH = 3; //to be managed by user configuration
const INITIAL_DEALY = 500; //to be managed by user configuration
const MINUTES_TO_CLOSE = 10 * 60000;
let FALSE_ALARM = false;
let BROWSER_PATH;

const STRING_PLACEHOLDER = "placeholder";
const FAILED_SUMMARY_MSSG = "No se pudo generar un resumen";
const EMPTY_STRING = "";
const CRAWLED_RESULTS_JSON = "crawled_results.json";
const CRAWL_COMPLETE_FLAG = "crawl_complete.flag";
const CRAWL_COMPLETE_TEXT = "Crawling completed!";
const MOST_COMMON_TERM = "Most_Common_Term";

let addedLinks = new Set();
let workers = [];
terms = terms.map((term) => term.toLowerCase());

/** Avoids capturing stack trace to save memory    */
class LightweightError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LightweightError';
        Error.captureStackTrace = null;
    }
}

/** Patterns that contain comment sections **/
const patternsToRemove = [
    /<div id="comments" class="comments-area"*>[\s\S]*?<\/div>/gi,
    /<div id="comments"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi,
    /<div[^>]*(?:id|class)=[^>]*comments?[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-[^>]*>[\s\S]*?<\/div>/gi,
    /<ol[^>]*class=[^>]*commentlist[^>]*>[\s\S]*?<\/ol>/gi,
    /<div[^>]*id="respond"[^>]*>[\s\S]*?<\/div>/gi,
    /<h2[^>]*class=[^>]*comments-title[^>]*>[\s\S]*?<\/h2>/gi,
    /<li[^>]*class=[^>]*comment[^>]*>[\s\S]*?<\/li>/gi,
    /<form[^>]*id="commentform"[^>]*>[\s\S]*?<\/form>/gi,
    /<p[^>]*class=[^>]*comment-[^>]*>[\s\S]*?<\/p>/gi,
    /<section[^>]*(?:id|class)=[^>]*comments?[^>]*>[\s\S]*?<\/section>/gi,
    /<article[^>]*(?:id|class)=[^>]*comment[^>]*>[\s\S]*?<\/article>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-respond[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-reply[^>]*>[\s\S]*?<\/div>/gi,
    /<textarea[^>]*(?:id|name)=[^>]*comment[^>]*>[\s\S]*?<\/textarea>/gi,
    /<input[^>]*(?:id|name)=[^>]*comment[^>]*>/gi,
    /<button[^>]*(?:id|class)=[^>]*comment[^>]*>[\s\S]*?<\/button>/gi,
    /<a[^>]*class=[^>]*comment-reply-link[^>]*>[\s\S]*?<\/a>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-author[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-metadata[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-content[^>]*>[\s\S]*?<\/div>/gi,
    /<nav[^>]*(?:id|class)=[^>]*comment-navigation[^>]*>[\s\S]*?<\/nav>/gi,
    /<ul[^>]*(?:id|class)=[^>]*comment-list[^>]*>[\s\S]*?<\/ul>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-pagination[^>]*>[\s\S]*?<\/div>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-awaiting-moderation[^>]*>[\s\S]*?<\/div>/gi,
    /<p[^>]*(?:id|class)=[^>]*comment-notes[^>]*>[\s\S]*?<\/p>/gi,
    /<p[^>]*(?:id|class)=[^>]*comment-form-[^>]*>[\s\S]*?<\/p>/gi,
    /<div[^>]*(?:id|class)=[^>]*comment-subscription-form[^>]*>[\s\S]*?<\/div>/gi
];

let globalLinks = new Set();

function addLinkGlobally(link) {
    if (!globalLinks.has(link)) {
        globalLinks.add(link);
        return true;
    }
    return false;
}

/** Removes patterns from the content recursively.
 * @param {string} content - The content to remove patterns from.
 * @return {string} The content with patterns removed.      */
const removePatterns = (content) => {
    let newContent = content;
    let changed = false;

    for (let pat of patternsToRemove) {
        const tempContent = newContent.replace(pat, '');
        if (tempContent !== newContent) {
            newContent = tempContent;
            changed = true;
        }
    }

    if (changed) {
        return removePatterns(newContent);
    }

    return newContent;
};

const parseTime = (timeStr) => {
    // Regular expression to match HH:MM format
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;

    if (!timeRegex.test(timeStr)) {
        throw new LightweightError('Invalid time format. Please use HH:MM (24-hour format).');
    }

    const [hourStr, minuteStr] = timeStr.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (isNaN(hour) || isNaN(minute)) {
        throw new LightweightError('Invalid time: hour or minute is not a number');
    }

    const now = new Date();
    const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);

    // Subtract MINUTES_TO_CLOSE
    result.setMinutes(result.getMinutes() - Math.floor(MINUTES_TO_CLOSE / 60000));

    // If the resulting time is earlier than now, set it to tomorrow
    if (result <= now) {
        result.setDate(result.getDate() + 1);
    }

    return result;
};

let globalStopFlag = false;

//FUNCTIONS
/** Assigns a valid browser path to the BROWSER_PATH variable based on the configuration
 * @return {Promise<void>} A promise that resolves when the browser path is assigned.   */
async function assignBrowserPath() {
    BROWSER_PATH = config.browser.path === STRING_PLACEHOLDER
        ? await findValidChromiumPath()
        : config.browser.path;
}

const todayDate = () => {
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0'); // Months are zero-based
    const year = today.getFullYear();
    return `${day}/${month}/${year}`;
}

const sleep = async (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extracts the text content of an article from a given URL.
 *
 * @param {string} url - The URL of the article.
 * @return {Promise<string>} A Promise that resolves to the extracted text content. */
async function extractArticleText(url) {
    try {
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        let articleHtml = await page.evaluate(() => {
            const mainSelectors = [
                'article', 'main', 'section', '.article-body',
                '.content', '.main-content', '.entry-content',
                '.post-content', '.story-body', '.news-article'
            ];

            let mainElement = null;
            for (let selector of mainSelectors) {
                mainElement = document.querySelector(selector);
                if (mainElement) break;
            }

            return mainElement ? mainElement.innerHTML : '';
        });

        await browser.close();

        if (articleHtml === EMPTY_STRING) {
            articleHtml = await fetchTextWithRetry(url);
        }

        return cleanText(articleHtml);
    } catch (error) {
        try {
            const html = await fetchTextWithRetry(url);
            return cleanText(html);
        } catch (fetchError) {
            console.error(`Fetch error for ${url}: ${fetchError.message}`);
            return EMPTY_STRING;
        }
    }
}

/** Cleans the HTML text by removing patterns, sanitizing, and replacing unwanted characters.
 * @param {string} html - The HTML text to be cleaned.
 * @return {string} The cleaned HTML text.  */
const cleanText = (html) => {
    let cleanedHtml = removePatterns(html);

    cleanedHtml = sanitizeHtml(cleanedHtml, {
        allowedTags: [],
        allowedAttributes: {}
    });

    cleanedHtml = cleanedHtml
        .replace(/\n/g, ' ')
        .replace(/\t/g, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return cleanedHtml;
};

async function getChunkedOpenAIResponse(text, topic, maxTokens) {
    /** Generates a prompt for OpenAI to generate a summary of a specific part of a news article.
     * @param {string} news_content - The content of the news article.
     * @param {string} news_topic - The topic of the news article.
     * @param {number} current - The current part number of the news article being summarized.
     * @param {number} total - The total number of parts in the news article.
     * @return {string} The generated prompt for OpenAI.                                            */
    function getPrompt(news_content, news_topic, current, total) {
        return `Haz un resumen del siguiente fragmento que cubre la parte ${current} de ${total}` +
            `de la siguiente noticia:\n\n\n\n${news_content}\n\n\n\n` +
            `Ignora todo texto que no tenga que ver con el tema de la noticia: ${news_topic}`;
    }

    try {
        const chunks = splitTextIntoChunks(text);
        let respuesta = EMPTY_STRING;
        maxTokens = Math.floor(maxTokens / chunks.length);

        for (let i = 0; i < chunks.length; i++) {
            let content = getPrompt(chunks[i], topic, (i + 1), chunks.length);
            const response = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [{ role: "user", content: content }],
                stream: true,
                max_tokens: maxTokens,
                temperature: 0.1,
                top_p: 0.1,
                frequency_penalty: 0.0,
                presence_penalty: 0.0,
            });

            for await (const chunkResponse of response) {
                respuesta += chunkResponse.choices[0]?.delta?.content || EMPTY_STRING;
            }
        }

        return respuesta;
    } catch (error) {
        console.error('Error in OpenAI response:', error);
        return EMPTY_STRING;
    }
}

/** Counts the tokens of a string
 *  @param {String} text The text whose tokens are to be counted
 *  @returns {number} The amount of tokens      */
const countTokens = (text) => text.trim().split(/\s+/).length;


/** Splits a text into chunks of a maximum number of tokens per call
 * @param {string} text - The text to be split into chunks.
 * @return {string[]} An array of chunks, each containing a maximum of MAX_TOKENS_PER_CALL tokens. */
function splitTextIntoChunks(text) {
    const tokens = text.split(/\s+/);
    const chunks = [];
    let currentChunk = EMPTY_STRING;

    for (const token of tokens) {
        if ((currentChunk + " " + token).length <= MAX_TOKENS_PER_CALL) {
            currentChunk += " " + token;
        } else {
            chunks.push(currentChunk.trim());
            currentChunk = token;
        }
    }

    if (currentChunk) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

async function getNonChunkedOpenAIResponse(text, topic, maxTokens) {
    text = `Haz un resumen de la siguiente noticia:\n\n\n\n${text}\n\n\n\nIgnora todo texto que no tenga que ver con el tema de la noticia: ${topic}`;
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: text }],
            stream: true,
            max_tokens: maxTokens,
            temperature: 0.1,
            top_p: 0.1,
            frequency_penalty: 0.0,
            presence_penalty: 0.0,
        });
        let respuesta = EMPTY_STRING;
        for await (const chunk of response) {
            respuesta += chunk.choices[0]?.delta?.content || EMPTY_STRING;
        }
        return respuesta;
    } catch (error) {
        console.error('Error in OpenAI response:', error);
        return EMPTY_STRING;
    }
}


/**
 * Retrieves an OpenAI response for the given text and title.
 *
 * @param {string} text - The text to be summarized.
 * @param {string} topic - The topic of the news article.
 * @param {number} maxTokens - The maximum number of tokens allowed in the response.
 * @return {Promise<string>} A promise that resolves to the OpenAI response. If the text is empty or the topic is empty, an empty string is returned. If the number of tokens in the text exceeds the maximum allowed tokens per call, the function calls getChunkedOpenAIResponse to handle the text in chunks. 
 * Otherwise, it calls getNonChunkedOpenAIResponse to generate the response.  */
async function getOpenAIResponse(text, topic, maxTokens) {
    if (text == EMPTY_STRING || topic == EMPTY_STRING) {
        return EMPTY_STRING;
    }

    if (countTokens(text) >= MAX_TOKENS_PER_CALL) {
        return getChunkedOpenAIResponse(text, topic, maxTokens);
    }

    return getNonChunkedOpenAIResponse(text, topic, maxTokens);
}

/**
 * Retrieves the content of a webpage behind a paywall by using a proxy website.
 *
 * @param {string} link - The URL of the webpage.
 * @return {Promise<{url: string, content: string}>} A promise that resolves to an object containing the content of the webpage 
 * and the URL of the retrieved content if it is successfully retrieved, or an empty string if an error occurs.     */
async function getProxiedContent(link) {
    try {
        console.log(`Article may be behind a PayWall :-(\nLet's try to access via proxy for ${link} ...`);
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: BROWSER_PATH
        });
        const page = await browser.newPage();
        await page.goto('https://www.removepaywall.com/', { waitUntil: 'domcontentloaded' });
        await page.type('input#simple-search', link);
        await page.click('#__next > div > section > div > header > div > div:nth-child(4) > form > button');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });

        const content = await page.evaluate(() => document.body.innerText);
        const retrievedUrl = page.url();

        await browser.close();
        return { url: retrievedUrl, content: content };
    } catch (error) {
        console.error('Error in fetching proxied content:', error);
        return { url: EMPTY_STRING, content: EMPTY_STRING };
    }
}

/**
 * Retrieves a summary of the text using OpenAI's GPT-4 model.
 *
 * @param {string} link - The URL of the webpage
 * @param {string} fullText - The text content of the news article
 * @param {number} numberOfLinks - The total number of links under the same TERM search
 * @param {string} topic - The topic of the news article
 * @return {Promise<{url: string, response: string}>} A promise that resolves to an object containing the summary of the text and the valid URL.  */
const summarizeText = async (link, fullText, numberOfLinks, topic) => {
    let text = fullText;
    let maxTokens = 150 + Math.ceil(300 / numberOfLinks);
    let response = EMPTY_STRING;
    let count = 0;
    let url = link;

    while ((response === EMPTY_STRING || countTokens(text) < 150) && count < 3) {
        if (count === 0) {
            response = await getOpenAIResponse(text, topic, maxTokens);
        } else if (count === 1) {
            ({ url, content: text } = await getProxiedContent(link));
            response = await getOpenAIResponse(text, topic, maxTokens);
        } else {
            response = FAILED_SUMMARY_MSSG;
            url = link;
        }
        count++;
    }

    return { url, response };
};


/**
 * Checks if a given date is recent.
 *
 * @param {string} dateText - The date to be checked.
 * @return {boolean} Returns true if the date is recent, false otherwise.   */
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

    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

    // Handle "dd MMM yyyy HH:mm:ss +ZZZZ" format
    const rfc822Match_1 = dateText.match(/(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})/);
    if (rfc822Match_1) {
        const [_, day, month, year, time, offset] = rfc822Match_1;
        date = new Date(`${year}-${(months[month] + 1).toString().padStart(2, '0')}-${day.padStart(2, '0')}T${time}${offset}`);
        return differenceInHours(now, date) < 24;
    }

    // Try parsing as RFC 2822
    const rfc2822Match_2 = dateText.match(/[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}|GMT)/);
    if (rfc2822Match_2) {
        const [_, day, monthStr, year, time, offset] = rfc2822Match_2;
        const month = months[monthStr];
        const combinedDate = `${year}-${month + 1}-${day}T${time}`;
        date = new Date(combinedDate);

        if (offset !== 'GMT') {
            const offsetHours = parseInt(offset.slice(0, 3));
            const offsetMinutes = parseInt(offset.slice(3));
            const totalOffsetMinutes = offsetHours * 60 + (offsetHours < 0 ? -offsetMinutes : offsetMinutes);
            date = subMinutes(date, totalOffsetMinutes);
        }
        return differenceInHours(now, date) < 24;
    }

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

    // Handle "dd/MM/yyyy HH:mm:ss Z" format
    let tzOffsetMatch = dateText.match(/(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})/);
    if (tzOffsetMatch) {
        let [_, datePart, offset] = tzOffsetMatch;
        date = parse(datePart, 'dd/MM/yyyy HH:mm:ss', new Date());
        if (isValid(date)) {
            let [hoursOffset, minutesOffset] = offset.split(':').map(Number);
            let totalOffsetMinutes = hoursOffset * 60 + (hoursOffset < 0 ? -minutesOffset : minutesOffset);
            date = subMinutes(date, totalOffsetMinutes);
            return differenceInHours(now, date) < 24;
        }
    }

    let cosa = dateText.match(/(\d{2}\/\d{2}\/\d{4} \d{1}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})/);
    if (cosa) {
        let [_, datePart, offset] = cosa;
        date = parse(datePart, 'dd/MM/yyyy H:mm:ss', new Date());
        if (isValid(date)) {
            let [hoursOffset, minutesOffset] = offset.split(':').map(Number);
            let totalOffsetMinutes = hoursOffset * 60 + (hoursOffset < 0 ? -minutesOffset : minutesOffset);
            date = subMinutes(date, totalOffsetMinutes);
            return differenceInHours(now, date) < 24;
        }
    }

    // Handle "YYYY-MM-DD[TIMEZONE]HH:MM:SS" format
    let tzAbbrMatch = dateText.match(/(\d{4}-\d{2}-\d{2})([A-Z]{3,5})(\d{2}:\d{2}:\d{2})/);
    if (tzAbbrMatch) {
        let [_, datePart, tz, timePart] = tzAbbrMatch;
        let combinedDate = `${datePart}T${timePart}`;

        let offset = offsetMap[tz];
        if (offset !== undefined) {
            date = parse(combinedDate, "yyyy-MM-dd'T'HH:mm:ss", new Date());
            if (isValid(date)) {
                let totalOffsetMinutes = offset * 60;
                date = subMinutes(date, totalOffsetMinutes);
                return differenceInHours(now, date) < 24;
            }
        }
    }

    // Handle "YYYY-MM-DD[TIMEZONE]HH:MM" format
    let tzMatch = dateText.match(/(\d{4}-\d{2}-\d{2})([A-Z]{3,5})(\d{2}:\d{2})/);
    if (tzMatch) {
        let [_, datePart, tz, timePart] = tzMatch;
        let combinedDate = `${datePart}T${timePart}`;

        let offset = offsetMap[tz];
        if (offset !== undefined) {
            date = parse(combinedDate, "yyyy-MM-dd'T'HH:mm", new Date());
            if (isValid(date)) {
                let totalOffsetMinutes = offset * 60;
                date = subMinutes(date, totalOffsetMinutes);
                return differenceInHours(now, date) < 24;
            }
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
    let preambleMatch = dateText.match(/.*, (\w+ \d{2}, \d{4})/);
    if (preambleMatch) {
        let [_, datePart] = preambleMatch;
        date = parse(datePart, 'MMMM dd, yyyy', new Date(), { locale: enUS });
        if (isValid(date)) {
            return differenceInHours(now, date) < 24;
        }
    }

    // Handle relative dates
    let relativeMatchES = dateText.match(/hace (\d+) (minutos?|horas?|días?|semanas?|meses?)/i);
    let relativeMatchEN = dateText.match(/(\d+) (minute|hour|day|week|month)s? ago/i);
    if (relativeMatchES || relativeMatchEN) {
        let [_, amount, unit] = relativeMatchES || relativeMatchEN;
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
    }

    // Handle various date formats
    let formats = [
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
        "EEEE d 'de' MMMM"
    ];

    for (let format of formats) {
        date = parse(dateText, format, new Date(), { locale: es });
        if (isValid(date)) break;
        date = parse(dateText, format, new Date(), { locale: enUS });
        if (isValid(date)) break;
    }

    if (isValid(date)) {
        return differenceInHours(now, date) < 24;
    }

    // Handle natural language dates like "Panamá, 09 de julio del 2024"
    let spanishMonthAbbr = {
        'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
        'jul': 6, 'ago': 7, 'sept': 8, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
    };
    let match = dateText.match(/(\d{1,2})?\s*(?:de)?\s*(\w+)\.?\s*(?:de)?\s*(\d{4})?/i);
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

    let nlMatch = dateText.match(/(\d{1,2})\s*de\s*(\w+)\s*del?\s*(\d{4})/i);
    if (nlMatch) {
        let [_, day, month, year] = nlMatch;
        let spanishMonthFull = {
            'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
            'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
        };
        month = spanishMonthFull[month.toLowerCase()];
        if (month !== undefined) {
            date = new Date(parseInt(year), month, parseInt(day));
            return differenceInHours(now, date) < 24;
        }
    }

    console.warn(`Could not parse date: ${dateText}`);
    return false;
}

/** Wrapper function to get the text data of a given URL
 * @param {string} url 
 * @returns {string} The text data      */
async function fetchTextWithRetry(url) {
    const response = await fetchWithRetry(url);
    if (typeof response === 'string') {
        return response;
    } else if (response && typeof response.data === 'string') {
        return response.data;
    } else {
        throw new Error('Unexpected response format');
    }
}

/** Fetches data from a given URL with retry logic.
 * @param {string} url - The URL to fetch data from.
 * @param {number} [retries=0] - The number of retries.
 * @param {number} [initialDelay=INITIAL_DEALY] - The initial delay in milliseconds.
 * @return {Promise<any>} A Promise that resolves to the fetched data.
 * @throws {Error} If the maximum number of retries is reached. */
async function fetchWithRetry(url, retries = 0, initialDelay = INITIAL_DEALY) {
    if (globalStopFlag) {
        throw new LightweightError('Crawl stopped');
    }
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
            throw new LightweightError(`Failed to fetch ${url} after ${MAX_RETRIES_PER_FETCH} retries: ${error.message}`);
        }
        const delay = initialDelay * Math.pow(3, retries);
        console.log(`Attempt ${retries + 1} failed for ${url}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, retries + 1, delay);
    }
}

/** Calculates the relevance score and finds the most common term in the given text.
 * @param {string} title - The title of the article.
 * @param {string} articleContent - The content of the article.
 * @return {object} An object containing the score and the most common term.
 *     - {number} score: The relevance score.
 *     - {string} mostCommonTerm: The most common term found in the text.   */
const relevanceScoreAndMaxCommonFoundTerm = (title, articleContent) => {
    const text = (title + ' ' + articleContent).toLowerCase();
    let score = 0, mostCommonTerm = '', maxCommonFoundTermCount = 0;

    for (const term of terms) {
        const regex = new RegExp("\\b" + term + "\\b", 'ig');
        const matches = text.match(regex) || [];
        const termCount = matches.length;
        if (termCount > 0) {
            score++; // Increment for each term found at least once
            if (termCount > maxCommonFoundTermCount) {
                mostCommonTerm = term;
                maxCommonFoundTermCount = termCount;
            }
        }
    }

    return { score, mostCommonTerm };
};

/** Normalizes a URL by removing the trailing slash if it exists.
 * @param {string} url - The URL to be normalized.
 * @return {string} The normalized URL.          */
const normalizeUrl = (url) => {
    if (url[url.length - 1] === '/') {
        url = url.slice(0, -1);
    }
    return url;
};

/**
 * Checks if the current time is close to the provided email end time.
 *
 * @param {Date} emailEndTime - The end time for the email
 * @return {boolean} Returns true if the current time is close to the email end time, false otherwise   */
function closeToEmailingTime(emailEndTime) {
    // Check if emailEndTime is a valid Date object
    if (!(emailEndTime instanceof Date) || isNaN(emailEndTime.getTime())) {
        console.error('Invalid emailEndTime provided to closeToEmailingTime');
        return false;
    }

    const now = new Date();
    const endWindow = new Date(emailEndTime.getTime() + MINUTES_TO_CLOSE);

    if (now >= emailEndTime && now < endWindow) {
        globalStopFlag = true;
        return true;
    }

    return false;
}

const rateLimiter = new RateLimiter({
    tokensPerInterval: 1,
    interval: 'second',
    fireImmediately: true
});

/** Creates a new worker thread with the specified workerData.
 * @param {Object} workerData - The data to pass to the worker.
 * @return {Promise<any>} A promise that resolves with the response from the worker */
function createWorker(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
            workerData: {
                ...workerData,
                addedLinks: Array.from(addedLinks)
            }
        });
        workers.push(worker);

        let latestResult = { articles: {} };

        worker.on('message', (message) => {
            switch (message.type) {
                case 'result':
                case 'partial_result':
                    if (message.result && message.result.articles) {
                        for (const [term, articles] of Object.entries(message.result.articles)) {
                            if (!latestResult.articles[term]) {
                                latestResult.articles[term] = [];
                            }
                            latestResult.articles[term].push(...articles);
                        }
                    }
                    if (message.type === 'partial_result') {
                        console.log('Received partial result due to possible memory constraints');
                    } else {
                        console.log('Received final result from worker');
                        resolve(latestResult);
                    }
                    break;
                case 'progress':
                    if (message.result && message.result.articles) {
                        for (const [term, articles] of Object.entries(message.result.articles)) {
                            if (!latestResult.articles[term]) {
                                latestResult.articles[term] = [];
                            }
                            latestResult.articles[term].push(...articles);
                        }
                    }
                    console.log('Received progress update from worker');
                    break;
                case 'addLinks':
                    message.links.forEach(link => addedLinks.add(link));
                    break;
                case 'error':
                    console.error(`Worker error: ${message.error.message}`);
                    break;
            }
        });

        worker.on('error', (error) => {
            console.error(`Worker error: ${error}`);
            workers = workers.filter(w => w !== worker);
            if (error.message.includes('out of memory')) {
                console.log('Worker ran out of memory, resolving with latest result');
                resolve(latestResult);
            } else {
                reject(error);
            }
        });

        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
            workers = workers.filter(w => w !== worker);
            // Resolve with the latest result even if the worker exited unexpectedly
            resolve(latestResult);
        });

        // Ensure worker terminates after timeout
        setTimeout(() => {
            if (worker.threadId) {
                console.log(`Terminating worker ${worker.threadId} due to timeout`);
                worker.terminate();
            }
        }, workerData.cycleEndTime - Date.now());
    });
}

/** Asynchronously detects and retrieves RSS feeds from the provided URL.
 *
 * @param {string} url - The URL to fetch the RSS feed from.
 * @return {Array} An array of RSS feed URLs extracted from the provided URL.           */
async function detectRSS(url, baseUrl, rssFeeds = new Set(), depth = 0) {
    if (globalStopFlag) {
        return Array.from(rssFeeds);
    }

    const MAX_DEPTH = 4;

    if (depth > MAX_DEPTH) {
        return Array.from(rssFeeds);
    }
    try {
        const data = await fetchWithRetry(url);
        let $ = cheerio.load(data);

        // Añadir los feeds RSS encontrados a la lista
        $('link[type="application/rss+xml"], link[type="application/atom+xml"]').each((i, elem) => {
            try {
                const feedUrl = $(elem).attr('href');
                const absoluteFeedUrl = new URL(feedUrl, baseUrl).href;
                rssFeeds.add(absoluteFeedUrl);
            } catch (err) {
                let error = new LightweightError(err.message);
                console.error('Invalid URL:', $(elem).attr('href'), error.message);
                error = null;
            }
        });

        // Buscar enlaces en la página que contengan "/rss/"
        let subRSSLinks = $('a[href*="/rss/"]').map((i, elem) => $(elem).attr('href')).get();

        for (const link of subRSSLinks) {
            try {
                const fullLink = new URL(link, baseUrl).href;
                await detectRSS(fullLink, baseUrl, rssFeeds, depth);
            } catch (err) {
                let error = new LightweightError(err.message);
                console.error('Invalid URL:', link, error.message);
                error = null;
            }
        }

        return Array.from(rssFeeds);
    } catch (error) {
        console.error('Error fetching the URL:', error.message);
        return Array.from(rssFeeds);
    } finally {
        $ = null; // Clear the cheerio object to free memory
    }
}

async function sanitizeXML(xml) {
    let sanitized = decode(xml);
    return sanitized;
}

/** Extracts the full text content from the given item object based on a priority list of content fields.
 *
 * @param {object} item - The item object containing various content fields.
 * @return {string} The extracted full text content.        */
function extractFullText(item) {
    /** A priority list of possible content fields*/
    const contentFields = [
        'content:encoded',
        'content',
        'description',
        'summary',
        'fulltext',
        'body',
        'article',
        'story'
    ];

    let fullText = [];

    // Check each field in order of priority
    for (const field of contentFields) {
        if (item[field]) {
            if (typeof item[field] === 'string') {
                fullText.push(item[field]);
            } else if (typeof item[field] === 'object' && item[field]['#text']) {
                fullText.push(item[field]['#text']);
            } else if (Array.isArray(item[field]) && item[field][0]) {
                fullText.push(item[field][0]);
            }
        }
    }

    if (fullText.length > 0) {
        fullText = fullText.sort((a, b) => b.length - a.length)[0];
    } else {
        fullText = null;
    }

    // If no content found, concatenate title and description as fallback
    if (!fullText && item.title) {
        fullText = item.title;
        if (item.description) {
            fullText += ' ' + item.description;
        }
    }

    return cleanText(fullText);
}


/** Check if the given item is an opinion article based on category, title, and link.
 * @param {Object} originalItem - The original item to check for being an opinion article.
 * @return {boolean} Returns true if the item is an opinion article, false otherwise.   */
function isOpinionArticle(originalItem) {
    if (originalItem.category) {
        const categories = Array.isArray(originalItem.category) ? originalItem.category : [originalItem.category];
        if (categories.some(cat => typeof cat === 'string' && cat.toLowerCase() === 'opinión')) {
            return true;
        }
    }

    const opinionKeywords = ['opinión', 'editorial', 'columna', 'punto de vista'];
    if (originalItem.title && typeof originalItem.title === 'string' &&
        opinionKeywords.some(keyword => originalItem.title.toLowerCase().includes(keyword))) {
        return true;
    }

    const link = extractLink(originalItem.link);
    if (link && urlContainsOpinion(link)) {
        return true;
    }

    return false;
}

function normalizeItem(item) {
    return {
        title: cleanText(item.title || ''),
        link: extractLink(item.link || item.guid),
        date: item.pubDate || item.updated || item.published,
        fullText: extractFullText(item)
    };
}

/** Extracts a link from the provided linkData.
 * @param {any} linkData - The input data to extract the link from.
 * @return {string | null} The extracted link or null if unable to extract. */
function extractLink(item) {
    if (typeof item === 'string') {
        return item;
    }

    if (!item) {
        return null;
    }

    if (Array.isArray(item)) {
        return item.map(subItem => extractLink(subItem)).filter(link => link !== null);
    }

    if (item.link) {
        if (typeof item.link === 'string') {
            return item.link;
        }
        if (Array.isArray(item.link)) {
            const alternateLink = item.link.find(l => l['@_rel'] === 'alternate');
            return alternateLink ? alternateLink['@_href'] : (item.link[0] ? item.link[0]['@_href'] : null);
        }
    }

    if (item.description && item.description.link) {
        return item.description.link;
    }

    if (item.guid) {
        if (typeof item.guid === 'string') {
            return item.guid;
        }
        if (item.guid['@_isPermaLink'] === true && item.guid['#text']) {
            return item.guid['#text'];
        }
    }

    if (item.item) {
        return extractLink(item.item);
    }

    return null;
}

/** Asynchronously scrapes an RSS feed from the provided URL, extracts relevant article information,
 * and returns an array of articles.
 *
 * @param {string} feedUrl - The URL of the RSS feed to scrape.
 * @return {Array} An array of articles with title, link, date, content, score, summary, and full text.         */
async function scrapeRSSFeed(feedUrl, workerAddedLinks) {
    let results = {};
    terms.forEach(term => results[term] = []);

    try {
        const feedData = await fetchWithRetry(feedUrl);
        const sanitizedData = await sanitizeXML(feedData);

        const options = {
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            parseAttributeValue: true,
        };

        const parser = new XMLParser(options);
        const jsonObj = parser.parse(sanitizedData);

        if (!jsonObj.rss && !jsonObj.feed) {
            throw new LightweightError("Feed not recognized as RSS 1 or 2.");
        }

        const feed = jsonObj.rss ? jsonObj.rss.channel : jsonObj.feed;
        let items = feed.item || feed.entry;

        if (!items || items.length === 0) {
            return results;
        }

        if (!Array.isArray(items)) {
            items = [items];
        }

        for (let item of items) {
            if (globalStopFlag) break;

            try {
                let link = extractLink(item);

                if (Array.isArray(link)) {
                    link = link[0];
                }

                if (!link) {
                    console.error('Invalid link format for item:', item);
                    continue;
                }

                link = normalizeUrl(link);

                if (!workerAddedLinks.has(link)) {
                    const title = cleanText(item.title);
                    const fullText = extractFullText(item);
                    const date = item.pubDate || item.updated;

                    if (!isRecent(date)) continue;
                    if (isOpinionArticle(item)) continue;
                    if (!addLinkGlobally(link)) continue;

                    const { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(title, fullText);

                    if (score > 0) {
                        workerAddedLinks.add(link);
                        console.log(`RSS-feed Added article! - ${link}`);

                        results[mostCommonTerm].push({
                            title,
                            link,
                            summary: STRING_PLACEHOLDER,
                            score,
                            term: mostCommonTerm,
                            fullText,
                            date
                        });
                    }
                }
            } catch (error) {
                console.error('Error processing item:', error, item);
                continue;
            }
        }

        return results;
    } catch (error) {
        console.error('Error parsing RSS feed:', error);
        return results;
    }
}

async function crawlWebsite(url, terms, workerAddedLinks) {
    if (globalStopFlag) {
        return {};
    }

    let results = {};
    terms.forEach(term => results[term] = []);

    async function searchLoop(resultados) {
        for (const term of terms) {
            if (globalStopFlag) {
                console.log("Stopping crawl due to global stop flag");
                return resultados;
            }

            try {
                const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}+site:${encodeURIComponent(url)}&filters=ex1%3a"ez5"`;
                const html = await fetchWithRetry(searchUrl);
                const $ = cheerio.load(html);

                const articleElements = $("li.b_algo");

                for (const article of articleElements) {
                    if (globalStopFlag) break;

                    const titleElement = $(article).find("h2");
                    const linkElement = titleElement.find("a");
                    const dateElement = $(article).find("span.news_dt");

                    if (titleElement.length && linkElement.length && dateElement.length) {
                        const title = titleElement.text().trim();
                        const link = normalizeUrl(linkElement.attr("href"));
                        const dateText = dateElement.text().trim();

                        if (!workerAddedLinks.has(link)) {
                            if (!isWebsiteValid(url, link) || !isRecent(dateText)) continue;

                            if (!addLinkGlobally(link)) {
                                continue;
                            }

                            try {
                                let articleContent = await extractArticleText(link);
                                const { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(title, articleContent);

                                if (score > 0) {
                                    workerAddedLinks.add(link);
                                    console.log(`Added article! - ${link}`);

                                    if (!resultados[mostCommonTerm] || resultados[mostCommonTerm] == null || resultados[mostCommonTerm] == undefined) {
                                        resultados[mostCommonTerm] = [];
                                    }
                                    resultados[mostCommonTerm].push({
                                        title,
                                        link,
                                        summary: STRING_PLACEHOLDER,
                                        score,
                                        term: mostCommonTerm,
                                        fullText: articleContent,
                                        date: dateText
                                    });
                                }

                                articleContent = null; // Clear articleContent to free up memory
                            } catch (error) {
                                console.error(`Error processing article ${link}: ${error.message}`);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error(`Error crawling ${url} for term ${term}: ${error.message}`);
                if (error.response) {
                    console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
                }
            }
        }
        return resultados;
    }

    console.log(`Crawling ${url}...`);

    let rssFeeds = await detectRSS(url, url);
    if (rssFeeds.length > 0) {
        console.log(`RSS detected! for ${url}`);
        try {
            for (let feedUrl of rssFeeds) {
                let feedResults = await scrapeRSSFeed(feedUrl, workerAddedLinks);
                for (let term in feedResults) {
                    if (!results[term] || results[term] == undefined || results[term] == null) results[term] = [];
                    results[term].push(...feedResults[term]);
                }
            }
        } catch (error) {
            console.log(`Error scraping RSS-feed of ${url}\nError: ${error.message}\nLet's continue with regular scraping`);
            results = await searchLoop(results);
        }
    } else {
        results = await searchLoop(results);
    }

    return results;
}

/**
 * Splits an array into a specified number of chunks.
 *
 * @param {Array} array - The array to be split into chunks.
 * @param {number} numChunks - The number of chunks to create.
 * @return {Array<Array>} An array of chunks, each containing a portion of the original array.  */
const chunkArray = (array, numChunks) => {
    let set = new Set(array);
    array = Array.from(set);
    
    if (numChunks <= 0) return [];
    if (numChunks >= array.length) return array.map(item => [item]);

    const chunks = Array.from({ length: numChunks }, () => []);
    const chunkSize = Math.floor(array.length / numChunks);
    const remainder = array.length % numChunks;
    
    let index = 0;
    for (let i = 0; i < numChunks; i++) {
        let size = chunkSize + (i < remainder ? 1 : 0);
        chunks[i] = array.slice(index, index + size);
        index += size;
    }
    
    return chunks;
};

/** Detects if an URL leads to an opinion */
const urlContainsOpinion = (url) => {
    return url ? url.toLowerCase().includes('#comment') || url.toLowerCase().includes('/opinion/') : false;
}

function isWebsiteValid(baseUrl, fullLink) {

    if (urlContainsOpinion(fullLink)) return false; //get rid of useless opinions. We're crawling FACTS!

    try {
        const baseHostname = new URL(baseUrl).hostname;
        const linkHostname = new URL(fullLink).hostname;

        if (baseHostname === linkHostname) {
            return false;
        }

        if (linkHostname.endsWith('.' + baseHostname) ||
            linkHostname.includes(baseHostname)) {
            return true;
        }

        return false;
    } catch (error) {
        console.warn(`Error comparing URLs: ${baseUrl} and ${fullLink}`);
        return false;
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

/**
 * Removes redundant articles from the given results object.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Promise<void>} A promise that resolves when the redundant articles have been removed.   */
const removeRedundantArticles = async (results) => {
    for (const term of terms) {
        const articles = results[term];
        const uniqueArticles = [];
        const toRemove = new Set(); // Keep track of indices to remove
        for (let i = 0; i < articles.length; i++) {
            if (toRemove.has(i)) continue; // Skip if already marked for removal
            let unique = true;
            for (let j = 0; j < articles.length; j++) {
                if (i !== j && !toRemove.has(j)) {
                    let localThreshold = Math.max(((100 - articles.length) / 100), SIMILARITY_THRESHOLD);
                    const sameNews = await coveringSameNews(
                        articles[i].fullText,
                        articles[j].fullText,
                        LANGUAGE,
                        localThreshold
                    );
                    if (sameNews || (articles[i].link == articles[j].link)) {
                        unique = false;
                        if (articles[i].score < articles[j].score) {
                            toRemove.add(i);
                        } else {
                            toRemove.add(j);
                        }
                        break; // Stop inner loop as we found a duplicate
                    }
                }
            }
            if (unique) uniqueArticles.push(articles[i]);
        }
        const filteredArticles = articles.filter((_, index) => !toRemove.has(index));
        results[term] = filteredArticles;
    }

    return results;
}


/** Checks if the given text is relevant based on the occurrence of terms.
 * @param {string} text - The text to be checked for relevance.
 * @return {boolean} Returns true if the text is relevant, false otherwise. */
function isTextRelevant(text) {
    for (const term of terms) {
        const regex = new RegExp(`\\b${term}\\b`, 'gi');
        const matches = text.match(regex) || [];
        if (matches.length > 1) {
            return true;
        }
    }
    return false;
}

/**
 * Arranges the articles from the given results object based on their terms.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Promise<Object>} - A promise that resolves to an object with articles reorganized by term */
async function removeIrrelevantArticles(results) {
    let reorganizedResults = {};

    for (const term of Object.keys(results)) {
        reorganizedResults[term] = [];
    }

    for (const [term, articles] of Object.entries(results)) {
        for (let article of articles) {
            if (article.fullText === '') {
                try {
                    article.fullText = await extractArticleText(article.link);
                } catch (error) {
                    console.error(`Error extracting text from ${article.link}: ${error.message}`);
                    continue;
                }
            }

            let textToAnalyze = article.title + ' ' + article.fullText;

            let mainTopics = getMainTopics(textToAnalyze, LANGUAGE, SENSITIVITY);
            if ((!mainTopics.some(topic => terms.includes(topic.toLowerCase())) || !isTextRelevant(textToAnalyze))
                && article.score === 1) {
                console.log(`Irrelevant article discarded: ${article.link}`);
                continue;
            }

            reorganizedResults[term].push(article);
        }
    }

    return reorganizedResults;
}

/**
 * Loads the previous results from the `crawled_results.json` file.
 * @return {Object} The previous results, or an empty object if the file doesn't exist or cannot be parsed. */
const loadPreviousResults = () => {
    console.log("Loading previous results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);

    try {
        if (fs.existsSync(resultsPath)) {
            const fileContent = fs.readFileSync(resultsPath, 'utf8');
            const previousResults = JSON.parse(fileContent);

            if (!previousResults.results) {
                throw new Error('Invalid results structure');
            }

            for (const articles of Object.values(previousResults.results)) {
                articles.forEach(article => {
                    if (addLinkGlobally(article.link)) {
                        addedLinks.add(article.link);
                    }
                });
            }

            return previousResults.results;
        } else {
            throw new Error('Results file does not exist');
        }
    } catch (err) {
        console.error("No previous results found. Loading new template...");
        let previousResults = {};
        terms.forEach(term => { previousResults[term] = []; });
        return previousResults;
    }
};

/** Extracts the top articles from the given results.
 * @param {Object} results - An object containing arrays of articles for each term.
 * @return {Array} An array of the top articles, with a maximum length determined by the square root of the total number of articles.   */
const extractTopArticles = (results) => {
    console.log("Extracting top articles...");
    let allRelevantArticles = [];
    for (let [term, articles] of Object.entries(results)) {
        if (articles.length === 0) continue;
        let mostRelevant;
        if (articles.length > 1) {
            mostRelevant = articles.sort((a, b) => b.score - a.score)[0];
        } else {
            mostRelevant = articles[0];
        }
        allRelevantArticles.push(mostRelevant);
    }

    allRelevantArticles.sort((a, b) => b.score - a.score);

    let relevantLength = allRelevantArticles.length;

    let potentialReturn = allRelevantArticles.slice(0, Math.floor(Math.sqrt(allRelevantArticles.length)));

    potentialReturn = potentialReturn.length > 0 ? potentialReturn : allRelevantArticles;

    let totalScore = 0;
    for (let i = 0; i < allRelevantArticles.length; i++) totalScore += allRelevantArticles[i].score;

    let acceptableProportion = ((100 - relevantLength) / 100);
    // Get top articles whose total is at least 'acceptableProportion'% of total score
    let threshold = Math.floor(totalScore * acceptableProportion);
    let topArticles = [];
    while (allRelevantArticles.length > 0 && threshold > 0) {
        threshold -= allRelevantArticles[0].score;
        topArticles.push(allRelevantArticles.shift());
    }
    // get the smaller amount of topArticles within a sensible range
    return potentialReturn.length < topArticles.length ? potentialReturn : topArticles;
};

/**
 * Returns a string of the most common terms in the given object of articles, sorted by frequency and score.
 *
 * @param {Object} allResults - An object containing arrays of articles for each term.
 * @return {string} A string of the most common terms, separated by '/' - DISCLAIMER: NORMALLY IT'S A SINGLE TERM        */
function mostCommonTerms(allResults) {
    const termCount = {};

    for (const [term, articles] of Object.entries(allResults)) {
        termCount[term] = articles.length;
    }

    const totalArticles = Object.values(allResults).flat().length;

    if (totalArticles === 1) {
        return Object.keys(termCount)[0];
    }

    const sortedTerms = Object.entries(termCount).sort((a, b) => b[1] - a[1]);
    const highestFrequency = sortedTerms[0][1];
    let topTerms = sortedTerms.filter(term => term[1] === highestFrequency);

    const numOfTopics = Math.floor(Math.cbrt(totalArticles));

    topTerms = topTerms.sort((a, b) => {
        const aMaxScore = Math.max(...allResults[a[0]].map(article => article.score));
        const bMaxScore = Math.max(...allResults[b[0]].map(article => article.score));
        return bMaxScore - aMaxScore;
    }).slice(0, numOfTopics).map(term => term[0]);

    return topTerms.join('/');
}

/**
 * Loads the results from a JSON file.
 *
 * @return {Object} The loaded results, or null if the file doesn't exist.  */
const loadResults = () => {
    console.log("Loading results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);
    if (fs.existsSync(resultsPath)) {
        return JSON.parse(fs.readFileSync(resultsPath));
    }
    return null;
};

const sendEmail = async (emailTime) => {
    console.log("Sending emails...");

    const now = new Date();
    const results = loadResults();
    const sender = config.email.sender;
    const recipients = config.email.recipients;
    const totalLinks = Object.values(results.results).flat().length ?? 0;
    const sortedResults = Object.entries(results.results).sort((a, b) => b[1].length - a[1].length) ?? [];

    let mostFrequentTerm = results.mostCommonTerm ?? EMPTY_STRING;
    const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
    let topArticles = results.topArticles ?? [];

    //Edge case of topArticles not extracted yet
    if (totalLinks > 0) {
        if (topArticles == []) {
            topArticles = await extractTopArticles(results.results);
        }
        if (mostFrequentTerm === MOST_COMMON_TERM || mostFrequentTerm === EMPTY_STRING) {
            mostFrequentTerm = mostCommonTerms(results.results);
        }
    }

    //Edge case of summaries not being present
    for (let i = 0; i < topArticles.length; i++) {
        let link = EMPTY_STRING, summary = EMPTY_STRING;
        if (topArticles[i].summary === STRING_PLACEHOLDER ||
            topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
            ({ url: link, response: summary } = await summarizeText(
                topArticles[i].link,
                topArticles[i].fullText,
                topArticles.length,
                topArticles[i].title
            ));
            topArticles[i].summary = summary;
            topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
        }
    }


    while (now < new Date(emailTime.getTime() + MINUTES_TO_CLOSE)) {
        console.log("Waiting...");
        await new Promise((r) => setTimeout(r, 90000));
        now.setTime(Date.now());
    }

    let topArticleLinks = [];

    let emailBody = `
        <div style="text-align: center;">
            <img src="https://github.com/V3RNE42/NEWS_CRAWLER/blob/main/assets/fresh_news.png?raw=true" style="max-width: 25%; height: auto; display: block; margin-left: auto; margin-right: auto;" alt="Noticias_Frescas_LOGO">
        </div>
        <br>
        Estas son las ${totalLinks} noticias frescas de ${todayDate()} :<br><br>`;

    if (topArticles.length) {
        emailBody += "Noticias Destacadas:<br><br>";
        topArticles.forEach((article) => {
            emailBody += `<a href="${article.link}">${article.title}</a><br>${article.summary}<br><br>`;
            topArticleLinks.push(article.link);
        });
    } else {
        emailBody += `<b>NO encontré noticias destacadas hoy</b><br>`;
    }

    emailBody += "<br>"

    sortedResults.forEach(([term, articles]) => {
        if (articles.length) {
            emailBody += `<b>${term.toUpperCase()} - ${articles.length} link${articles.length === 1 ? EMPTY_STRING : "s"}</b><br>`;
            articles.forEach((article) => {
                let isTopArticle = topArticleLinks.includes(article.link);
                emailBody += `<a href="${article.link}" style="color: ${isTopArticle ? "red" : "blue"};">${article.title}</a><br>`;
            });
            emailBody += "<br><br>";
        }
    });

    emailBody += "<br>¡Saludos!";

    const transporter = nodemailer.createTransport({
        host: config.email.smtp_server,
        port: config.email.smtp_port,
        secure: false,
        auth: {
            user: config.email.smtp_user,
            pass: config.email.smtp_pass,
        },
    });

    const mailOptions = {
        from: sender,
        to: recipients.join(", "),
        subject: subject,
        html: emailBody,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("Emails sent successfully!");

        fs.unlinkSync(path.join(__dirname, CRAWL_COMPLETE_FLAG));
        fs.unlinkSync(path.join(__dirname, CRAWLED_RESULTS_JSON));
        console.log("Cleanup complete: Deleted flag and results files.");
    } catch (error) {
        console.error(`Error sending emails: ${error}`);
    }
};

/** Performs forced garbage collection if available, otherwise provides instructions. */
const forceGarbageCollection = () => {
    if (global.gc) {
        global.gc();
        console.log('Forced garbage collection completed');
    } else {
        console.log('Garbage collection is not exposed. Use --expose-gc when launching node to enable forced garbage collection.');
    }
};

/** Crawls multiple websites for articles related to specified terms.
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
const crawlWebsites = async (cycleEndTime) => {
    console.log("Starting crawlWebsites function...");
    let allResults = {};
    for (const term of terms) allResults[term] = [];

    const shuffledWebsites = shuffleArray([...websites]);
    const maxConcurrentWorkers = os.cpus().length;
    let MINIMUM_AMOUNT_WORKERS = 1 + Math.floor(maxConcurrentWorkers * 0.2);
    const websiteChunks = chunkArray(shuffledWebsites, maxConcurrentWorkers);

    console.log(`Creating ${maxConcurrentWorkers} worker(s)...`);
    let startedWorkers = 0;  // Define startedWorkers here

    const workerPromises = websiteChunks.map((websiteChunk, index) => {
        console.log(`Worker ${index} assigned websites:`, websiteChunk);
        return createWorker({
            urlsToCrawl: websiteChunk,
            terms,
            cycleEndTime
        });
    });

    console.log("All workers created. Waiting for workers to start...");

    const allWorkersStarted = new Promise(resolve => {
        const checkInterval = setInterval(() => {
            if (startedWorkers === maxConcurrentWorkers) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
    });

    // Set up event listeners for 'started' messages
    workers.forEach(worker => {
        worker.once('message', (message) => {
            if (message.type === 'started') {
                startedWorkers++;
            }
        });
    });

    await allWorkersStarted;
    console.log("All workers have started. Beginning monitoring...");

    const timeoutPromise = new Promise(resolve =>
        setTimeout(() => {
            console.log("Timeout reached. Collecting results...");
            resolve('timeout');
        }, cycleEndTime.getTime() - Date.now())
    );

    const workerMonitoringPromise = new Promise((resolve) => {
        const intervalId = setInterval(() => {
            if (workers.length < MINIMUM_AMOUNT_WORKERS) {
                console.log(`Number of active workers (${workers.length}) fell below minimum (${MINIMUM_AMOUNT_WORKERS}). Stopping crawl.`);
                globalStopFlag = true;
                for (const worker of workers) {
                    worker.terminate();
                }
                workers = [];
                clearInterval(intervalId);
                resolve('below_minimum');
            }
        }, 5000);

        Promise.all(workerPromises).then(() => {
            clearInterval(intervalId);
            resolve('all_completed');
        });
    });

    const raceResult = await Promise.race([
        workerMonitoringPromise,
        timeoutPromise
    ]);

    console.log(`Race completed. Result: ${raceResult}`);

    console.log("Collecting results from all workers...");

    for (const workerPromise of workerPromises) {
        try {
            const workerResult = await workerPromise;
            if (workerResult && workerResult.articles) {
                for (const [term, articles] of Object.entries(workerResult.articles)) {
                    if (!allResults[term]) allResults[term] = [];
                    for (const article of articles) {
                        if (addLinkGlobally(article.link)) {
                            allResults[term].push(article);
                        }
                    }
                }
            }
        } catch (error) {
            let err = new LightweightError(error);
            console.error("Error retrieving worker results:", err);
            err = null;
        }
    }

    console.log("All results collected. Terminating workers...");
    try {
        for (const worker of workers) {
            worker.terminate();
        }
        workers = []; // Clear the workers array
    } catch {
        //do nothing
    }

    console.log("Crawling process completed.");
    return allResults;
};

/** Saves the results to a JSON file.
 * @param {Object} results - The results to be saved.
 * @return {Promise<boolean>} - A promise that resolves to a boolean indicating if the crawling is complete.    */
const saveResults = async (results, emailTime) => {
    await sleep(30000);
    console.log("Saving results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);
    const flagPath = path.join(__dirname, CRAWL_COMPLETE_FLAG);
    let topArticles = [];
    let numTopArticles = 0;
    let mostCommonTerm = MOST_COMMON_TERM;
    let link = EMPTY_STRING, summary = EMPTY_STRING;

    const thisIsTheTime = closeToEmailingTime(emailTime);
    if (thisIsTheTime) {
        results = await removeIrrelevantArticles(results);
        if (!IGNORE_REDUNDANCY) {
            results = await removeRedundantArticles(results);
        }
        topArticles = extractTopArticles(results);
        numTopArticles = topArticles.length;
        for (let i = 0; i < numTopArticles; i++) {
            if (topArticles[i].summary === STRING_PLACEHOLDER ||
                topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
                ({ url: link, response: summary } = await summarizeText(
                    topArticles[i].link,
                    topArticles[i].fullText,
                    numTopArticles,
                    topArticles[i].title));
                topArticles[i].summary = summary;
                topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
            }
        }
        mostCommonTerm = mostCommonTerms(results);
    }

    const resultsWithTop = { results, topArticles, mostCommonTerm };

    fs.writeFileSync(resultsPath, JSON.stringify(resultsWithTop, null, 2));
    if (thisIsTheTime && !(FALSE_ALARM)) {
        fs.writeFileSync(flagPath, CRAWL_COMPLETE_TEXT);
        console.log(CRAWL_COMPLETE_TEXT)
    }

    return thisIsTheTime;
};

const main = async () => {
    console.log("Starting main process...");
    let resultados;
    let emailTime = new Date();

    while (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG))) {
        console.log("Starting new crawling cycle...");
        globalStopFlag = false; // Reset the flag at the start of each cycle

        const now = new Date();
        emailTime = parseTime(config.time.email);
        console.log('Current emailEndTime:', emailTime);

        const crawlCycleEndTime = new Date(now.getTime() + 10 * 60 * 1000); // 1/6 hour from now
        const cycleEndTime = emailTime < crawlCycleEndTime ? emailTime : crawlCycleEndTime;

        console.log(`Cycle end time set to: ${cycleEndTime}`);

        resultados = loadPreviousResults();
        console.log("Previous results loaded.");

        const results = await crawlWebsites(cycleEndTime);
        console.log("Crawling completed. Processing results...");

        for (const [term, articles] of Object.entries(results)) {
            if (!resultados[term]) resultados[term] = [];
            resultados[term].push(...articles);
        }

        if (isMainThread) {
            await saveResults(resultados, emailTime);
            console.log("Results saved.");
        }

        // Force garbage collection after each cycle
        forceGarbageCollection();

        if (globalStopFlag) {
            console.log("Stopping main loop due to global stop flag");
            break;
        }

        console.log("Cycle completed. Checking if it's time to send email...");
        if (closeToEmailingTime(emailTime)) {
            console.log("It's time to send email. Breaking the loop.");
            break;
        }

        console.log("Waiting before starting next cycle...");
        await new Promise(resolve => setTimeout(resolve, 60000)); // 1 minute delay
    }

    if (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG)) && !(FALSE_ALARM)) {
        fs.writeFileSync(path.join(__dirname, CRAWL_COMPLETE_FLAG), CRAWL_COMPLETE_TEXT);
        console.log("Crawl complete flag created.");
    }

    console.log("Preparing to send email...");
    await sendEmail(emailTime);
    console.log("Email sent. Main process completed.");
};


if (isMainThread) {
    // Main thread code
    (async () => {
        await assignBrowserPath();
        console.log(`Webcrawler scheduled to run indefinitely. Emails will be sent daily at ${config.time.email}`);

        while (true) {
            console.log(`Running the web crawler at ${new Date().toISOString()}...`);
            await main()
                .then(() => console.log('Scheduled webcrawler run finished successfully\n\n\n'))
                .catch(error => console.error('Error in scheduled webcrawler run:', error, '\n\n\n'));
        }
    })();
} else {
    // Worker thread code
    (async () => {
        const { urlsToCrawl, terms, addedLinks: initialAddedLinks, cycleEndTime } = workerData;
        let workerAddedLinks = new Set(initialAddedLinks);

        const results = {};
        for (const term of terms) results[term] = [];

        parentPort.postMessage({ type: 'started' });

        for (const url of urlsToCrawl) {
            if (Date.now() >= cycleEndTime.getTime() || globalStopFlag) {
                break;
            }

            try {
                const websiteResults = await crawlWebsite(url, terms, workerAddedLinks);
                for (const [term, articles] of Object.entries(websiteResults)) {
                    if (!results[term]) results[term] = [];
                    results[term].push(...articles);
                    for (const article of articles) {
                        if (!workerAddedLinks.has(article.link)) {
                            workerAddedLinks.add(article.link);
                            parentPort.postMessage({ type: 'addLinks', links: [article.link] });
                        }
                    }
                }
            } catch (error) {
                if (globalStopFlag) break;
                parentPort.postMessage({
                    type: 'error',
                    error: new LightweightError(`Error processing ${url}: ${error.message}`)
                });
                continue;
            }

            if (globalStopFlag) break;

            parentPort.postMessage({
                type: 'progress',
                result: { articles: results }
            });
        }

        parentPort.postMessage({
            type: 'result',
            result: { articles: results }
        });
    })();
}