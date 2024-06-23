//MODULES AND IMPORTS
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio');
const axios = require("axios");
const { OpenAI } = require("openai");
const puppeteer = require('puppeteer');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { RateLimiter } = require('limiter');
const os = require('os');
const { parse, differenceInHours } = require('date-fns');
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
const MAX_RETRIES_PER_FETCH = 3; //to be managed by user configuration
const INITIAL_DEALY = 2000; //to be managed by user configuration
let BROWSER_PATH;

const STRING_PLACEHOLDER = "placeholder";
const FAILED_SUMMARY_MSSG = "No se pudo generar un resumen";
const EMPTY_STRING = "";
const CRAWLED_RESULTS_JSON = "crawled_results.json";
const CRAWL_COMPLETE_FLAG = "crawl_complete.flag";

class AsyncSet {
    constructor() {
        this.set = new Set();
    }
    async has(item) {
        return this.set.has(item);
    }
    async add(item) {
        this.set.add(item);
    }
}

let seenLinks = new AsyncSet();
terms = terms.map((term) => term.toLowerCase());

const parseTime = (timeStr) => {
    const [hour, minute] = timeStr.split(":").map(Number);
    return { hour, minute };
};

const emailEndTime = parseTime(config.time.email);

//FUNCTIONS
/** Assigns a valid browser path to the BROWSER_PATH variable based on the configuration
 * @return {Promise<void>} A promise that resolves when the browser path is assigned.   */
async function assignBrowserPath() {
    BROWSER_PATH = config.browser.path === STRING_PLACEHOLDER
        ? await findValidChromiumPath()
        : config.browser.path;
}

const todayDate = () => new Date().toISOString().split("T")[0];
const TODAY = todayDate();

const sleep = async (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extracts the text content of an article from a given URL.
 *
 * @param {string} url - The URL of the article.
 * @return {Promise<string>} A Promise that resolves to the extracted text content. */
async function extractArticleText(url) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: BROWSER_PATH
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    let articleText = await page.evaluate(() => {
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

        if (!mainElement) return '';

        const textContent = mainElement.innerText;
        return textContent;
    });

    await browser.close();

    if (articleText === EMPTY_STRING) {
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);
        articleText = $.html();
    }

    return cleanText(articleText);
}

/** Cleans the given text by removing HTML tags and trimming whitespace
 * @param {string} text - The text to be cleaned.
 * @return {string} The cleaned text.     */
const cleanText = (text) => {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: [] });
    return text.replace(/<[^>]*>/g, ' ').trim();
}

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
        await page.click('button.p-2.5.ml-2.text-sm.font-medium.text-white.bg-blue-900.rounded-lg.border.border-blue-700.hover\\:bg-blue-800.focus\\:ring-4.focus\\:outline-none.focus\\:ring-blue-300.dark\\:bg-blue-900.dark\\:hover\\:bg-blue-1000.dark\\:focus\\:ring-blue-800');
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
        }
        count++;
    }

    return { url, response };
};

const extractDateText = (element) => {
    const datePatterns = [
        'time',
        'span',
        '[data-date]',
        '[datetime]',
        '[data-publish-date]',
        '[date-publish-date]',
        '[data-pubdate]',
        '[date-pubdate]',
        '[data-created]',
        '[date-created]',
        '[date]',
        '.date-group-published',
        '.published-date',
        '.post-date',
        '.entry-date',
        '.article-date',
        '.meta-date'
    ];

    for (const pattern of datePatterns) {
        const dateElement = element.find(pattern);
        if (dateElement.length) {
            const dateText = dateElement.text().trim() || dateElement.attr('datetime') || dateElement.attr('data-date');
            if (dateText) {
                console.log(`Found date text "${dateText}" using pattern "${pattern}"`);
                return dateText;
            }
        }
    }

    return '';
};

// Function to generate exhaustive date formats
const generateDateFormats = () => {
    const delimiters = ['-', '/', ' '];
    const orders = [
        ['yyyy', 'MM', 'dd'],
        ['yyyy', 'dd', 'MM'],
        ['MM', 'dd', 'yyyy'],
        ['dd', 'MM', 'yyyy']
    ];

    const formats = [];

    orders.forEach(order => {
        delimiters.forEach(delimiter => {
            formats.push(order.join(delimiter));
            formats.push(order.join(`${delimiter}HH:mm`));
            formats.push(order.join(`${delimiter}HH:mm:ss`));
            formats.push(order.join(`${delimiter}HH:mm:ss.SSS`));
        });
    });

    // Adding verbose month formats
    formats.push('MMMM d, yyyy');
    formats.push('MMM d, yyyy');
    formats.push('d MMMM yyyy');
    formats.push('d MMM yyyy');

    return formats;
};

const isRecent = (dateText) => {
    const now = new Date(TODAY);
    let date;
    const formats = generateDateFormats();

    for (const format of formats) {
        try {
            date = parse(dateText, format, new Date());
            if (!isNaN(date)) {
                console.log(`Parsed date "${dateText}" using format "${format}"`);
                break;
            }
        } catch (e) {
            console.warn(`Failed to parse date "${dateText}" with format "${format}"`);
            continue;
        }
    }

    if (!date || isNaN(date)) {
        console.warn(`Unable to parse date: ${dateText}`);
        return false;
    }

    return differenceInHours(now, date) < 24;
};

async function fetchWithRetry(url, retries = 0, initialDelay = INITIAL_DEALY) {
    try {
        const randomDelay = Math.floor(Math.random() * 3000) + 1000;
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
            throw error;
        }
        const delay = initialDelay * Math.pow(2, retries);
        console.log(`Attempt ${retries + 1} failed for ${url}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return fetchWithRetry(url, retries + 1, delay);
    }
}

/**
 * Calculate the relevance score and find the most common term in the given text.
 *
 * @param {string} text - The text to analyze.
 * @return {object} An object containing the score and the most common term.    */
const relevanceScoreAndMaxCommonFoundTerm = (text) => {
    let score = 0, mostCommonTerm = EMPTY_STRING, maxCommonFoundTermCount = 0;

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

const normalizeUrl = (url) => {
    let normalizedUrl = url.trim().toLowerCase();
    if (normalizedUrl.endsWith('/')) {
        normalizedUrl = normalizedUrl.slice(0, -1);
    }
    return normalizedUrl;
};

/**
 * Checks if the current time is within 30 minutes of the end time.
 *
 * @param {Object} endTime - An object containing the hour and minute of the end time.
 * @param {number} endTime.hour - The hour of the end time.
 * @param {number} endTime.minute - The minute of the end time.
 * @return {boolean} Returns true if the current time is within 30 minutes of the end time, false otherwise.    */
const checkCloseToEmailBracketEnd = (endTime) => {
    const now = new Date();
    const end = new Date();
    end.setHours(endTime.hour, endTime.minute, 0, 0);
    const tenMinutesBeforeEnd = new Date(end.getTime() - 30 * 60000);
    return now >= tenMinutesBeforeEnd && now < end;
};

const rateLimiter = new RateLimiter({
    tokensPerInterval: 5,
    interval: 'second',
    fireImmediately: true
});

/** Creates a new worker thread with the specified workerData.
 * @param {Object} workerData - The data to pass to the worker.
 * @return {Promise<any>} A promise that resolves with the response from the worker */
function createWorker(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, { workerData });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) {
                reject(new Error(`Worker stopped with exit code ${code}`));
            }
        });
    });
}

const extractTitleText = (element) => {
    const titlePatterns = [
        'h1',
        'h2',
        'h3',
        'title',
        '.headline',
        '.article-title',
        '.news-title',
        '[data-headline]',
        '[data-title]',
        'meta[property="og:title"]',
        'meta[name="twitter:title"]'
    ];

    for (const pattern of titlePatterns) {
        const titleElement = element.find(pattern);
        if (titleElement.length) {
            // For meta tags, we need to get the content attribute
            if (pattern.startsWith('meta')) {
                const content = titleElement.attr('content');
                if (content) {
                    console.log(`Found title text "${content}" using pattern "${pattern}"`);
                    return content.trim();
                }
            } else {
                const titleText = titleElement.text().trim();
                if (titleText) {
                    console.log(`Found title text "${titleText}" using pattern "${pattern}"`);
                    return titleText;
                }
            }
        }
    }

    // Fallback to the text of the element itself if no specific title pattern matched
    const fallbackTitle = element.text().trim();
    console.log(`Using fallback title text "${fallbackTitle}"`);
    return fallbackTitle;
};

async function crawlWebsite(url, terms, scrapedLinks, maxRetries = 3) {
    let results = {};
    terms.forEach(term => results[term] = []);

    try {
        const html = await fetchWithRetry(url, maxRetries);
        const $ = cheerio.load(html);

        const linkPromises = $('a').map(async (index, element) => {
            const link = $(element).attr('href');
            if (!link) return null;

            try {
                const fullLink = normalizeUrl(new URL(link, url).href);

                if (isWebsiteValid(normalizeUrl(url), fullLink) && !(await scrapedLinks.has(fullLink))) {
                    const surroundingElement = $(element).closest('article,div,section,p');
                    const title = extractTitleText(surroundingElement);
                    const surroundingText = cleanText(surroundingElement.text().trim());
                    const dateText = extractDateText(surroundingElement);

                    if (isRecent(dateText)) {
                        const { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(title + ' ' + surroundingText);

                        if (score > 0) {
                            const randomDelay = Math.floor(Math.random() * 1000) + 500;
                            await sleep(randomDelay);

                            await scrapedLinks.add(fullLink);
                            console.log(`Added article! - ${fullLink}`);

                            return {
                                title: title,
                                link: fullLink,
                                summary: STRING_PLACEHOLDER,
                                score: score,
                                term: mostCommonTerm,
                                fullText: STRING_PLACEHOLDER,
                                date: dateText
                            };
                        }
                    }
                }
            } catch (error) {
                console.warn(`Warning: Error processing link ${link} from ${url}: ${error.message}`);
            }
            return null;
        }).get();

        const processedLinks = (await Promise.all(linkPromises)).filter(link => link !== null);

        processedLinks.forEach(link => {
            if (results[link.term]) {
                results[link.term].push(link);
            } else {
                results[link.term] = [link];
            }
        });
    } catch (error) {
        console.error(`Error crawling ${url} after ${maxRetries} retries: ${error.message}`);
        if (error.response) {
            console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
        }
    }

    return results;
}

function isWebsiteValid(baseUrl, fullLink) {
    try {
        const baseHostname = new URL(baseUrl).hostname;
        const linkHostname = new URL(fullLink).hostname;

        // Check if the hostnames are exactly the same
        if (baseHostname === linkHostname) {
            return false;
        }

        // Check if the link's hostname ends with the base hostname
        // This catches cases like 'subdomain.example.com' when base is 'example.com'
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

/**
 * Crawls multiple websites for articles related to specified terms.
 *
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
const crawlWebsites = async () => {
    const allResults = {};
    for (const term of terms) allResults[term] = [];

    const maxConcurrentWorkers = os.cpus().length;
    const chunkSize = Math.ceil(websites.length / maxConcurrentWorkers);
    const chunks = [];

    for (let i = 0; i < websites.length; i += chunkSize) {
        chunks.push(websites.slice(i, i + chunkSize));
    }

    const workerPromises = chunks.map(chunk => createWorker({ chunk, terms, seenLinks: Array.from(seenLinks) }));
    const results = await Promise.all(workerPromises);

    for (const result of results) {
        for (const [term, articles] of Object.entries(result.articles)) {
            allResults[term].push(...articles);
        }
        // Update seenLinks with links from this worker
        result.seenLinks.forEach(link => seenLinks.add(link));
    }

    return allResults;
};

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
                    const sameNews = await coveringSameNews(
                        articles[i].fullText,
                        articles[j].fullText,
                        LANGUAGE,
                        SIMILARITY_THRESHOLD
                    );
                    if (sameNews) {
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

async function arrangeArticles(results) {
    let reorganizedResults = {};

    terms.forEach(term => {
        reorganizedResults[term] = [];
    });

    for (const [term, articles] of Object.entries(results)) {
        for (let article of articles) {
            if (article.fullText === STRING_PLACEHOLDER) {
                try {
                    article.fullText = await extractArticleText(article.link);
                } catch (error) {
                    console.error(`Error extracting text from ${article.link}: ${error.message}`);
                    continue; // Skip this article if text extraction fails
                }
            }

            let mainTopics = getMainTopics(article.fullText, LANGUAGE, SENSITIVITY);
            if (!mainTopics.some(topic => terms.includes(topic.toLowerCase()))) {
                continue; // Skip this article if it's not relevant
            }

            let { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(article.fullText);
            article.score = score;
            article.term = mostCommonTerm;

            reorganizedResults[mostCommonTerm].push(article);
        }
    }

    return reorganizedResults;
}

/**
 * Saves the results to a JSON file.
 *
 * @param {Object} results - The results to be saved.
 * @return {Promise<boolean>} - A promise that resolves to a boolean indicating if the crawling is complete.    */
const saveResults = async (results) => {
    console.log("Saving results...");
    const resultsPath = path.join(__dirname, CRAWLED_RESULTS_JSON);
    const flagPath = path.join(__dirname, CRAWL_COMPLETE_FLAG);
    let topArticles = [];
    let numTopArticles = 0;
    let mostCommonTerm = "Most_Common_Term";
    let link = EMPTY_STRING, summary = EMPTY_STRING;

    const thisIsTheTime = checkCloseToEmailBracketEnd(emailEndTime);
    if (thisIsTheTime) {
        results = await arrangeArticles(results);
        results = await removeRedundantArticles(results);
        topArticles = extractTopArticles(results);
        numTopArticles = topArticles.length;
        for (let i = 0; i < numTopArticles; i++) {
            if (topArticles[i].summary === STRING_PLACEHOLDER ||
                topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
                ({ url: link, response: summary } = await summarizeText(
                    topArticles[i].link,
                    topArticles[i].fullText,
                    topArticles[i].term,
                    topArticles[i].title));
                topArticles[i].summary = summary;
                topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
            }
        }
        mostCommonTerm = mostCommonTerms(results);
    }

    const resultsWithTop = { results, topArticles, mostCommonTerm };

    fs.writeFileSync(resultsPath, JSON.stringify(resultsWithTop, null, 2));
    if (thisIsTheTime) {
        fs.writeFileSync(flagPath, "Crawling complete");
        console.log("Crawling complete!")
    }

    return thisIsTheTime;
};

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

            let seenLinks = new Set();
            for (const articles of Object.values(previousResults.results)) {
                articles.forEach(article => seenLinks.add(article.link));
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

/**
 * Extracts the top articles from the given results.
 *
 * @param {Object} results - An object containing arrays of articles for each term.
 * @return {Array} An array of the top articles, with a maximum length determined by the square root of the total number of articles.   */
const extractTopArticles = (results) => {
    console.log("Extracting top articles...");
    let allArticles = [];
    for (let articles of Object.values(results)) {
        allArticles.push(...articles);
    }
    allArticles.sort((a, b) => b.score - a.score);

    let potentialReturn = allArticles.slice(0, Math.floor(Math.sqrt(allArticles.length)));

    let totalScore = 0;
    for (let i = 0; i < allArticles.length; i++) totalScore += allArticles[i].score;
    let threshold = Math.floor(totalScore * 0.8); // Get top articles whose total is at least 80% of total score
    let topArticles = [];
    while (allArticles.length > 0 && threshold > 0) {
        threshold -= allArticles[0].score;
        topArticles.push(allArticles.shift());
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

/**
 * Sends an email with the latest crawled news results. The email is sent at a specific time specified in the configuration.
 * The email contains a summary of the total number of news links crawled, the most frequent term, and the top articles.
 * The top articles are displayed in a separate section with their respective links.
 * The function waits until the crawl is complete before sending the email.
 *
 * @return {Promise<void>} A promise that resolves when the email is sent successfully, or rejects with an error if there is an issue sending the email.    */
const sendEmail = async () => {
    console.log("Sending emails...");
    const emailTime = new Date();
    const [emailHour, emailMinute] = config.time.email.split(":");
    emailTime.setHours(emailHour, emailMinute, 0, 0);

    const results = loadResults();
    const sender = config.email.sender;
    const recipients = config.email.recipients;
    const totalLinks = Object.values(results.results).flat().length ?? 0;
    const sortedResults = Object.entries(results.results).sort((a, b) => b[1].length - a[1].length) ?? [];

    let mostFrequentTerm = results.mostCommonTerm ?? EMPTY_STRING;
    const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
    let topArticles = results.topArticles ?? [];

    //Edge case of summary not being present
    for (let i = 0; i < topArticles.length; i++) {
        let link = EMPTY_STRING, summary = EMPTY_STRING;
        if (topArticles[i].summary === STRING_PLACEHOLDER ||
            topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
            ({ url: link, response: summary } = await summarizeText(
                topArticles[i].link,
                topArticles[i].fullText,
                topArticles[i].term,
                topArticles[i].title
            ));
            topArticles[i].summary = summary;
            topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
        }
    }

    //Edge case of mostFrequentTerm being the default "Most_Common_Term"
    if (mostFrequentTerm === "Most_Common_Term" || mostFrequentTerm === "") {
        mostFrequentTerm = mostCommonTerms(results);
    }

    while (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG)) || emailTime.getTime() > Date.now()) {
        console.log("Waiting...");
        await new Promise((r) => setTimeout(r, 90000));
    }

    let topArticleLinks = [];

    let emailBody = `
        <div style="text-align: center;">
            <img src="https://raw.githubusercontent.com/V3RNE42/NEWS_CRAWLER/puppeteer_variant/assets/fresh_news.png" style="max-width: 25%; height: auto; display: block; margin-left: auto; margin-right: auto;" alt="Noticias_Frescas_LOGO">
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

const main = async () => {
    let resultados;
    let keepGoing = !(checkCloseToEmailBracketEnd(emailEndTime));

    while (keepGoing) {
        if (checkCloseToEmailBracketEnd(emailEndTime)) {
            keepGoing = false;
            break;
        }
        resultados = loadPreviousResults();
        const results = await crawlWebsites();
        for (const [term, articles] of Object.entries(results)) {
            resultados[term].push(...articles);
        }

        await saveResults(resultados);
    }

    if (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG))) {
        fs.writeFileSync(path.join(__dirname, CRAWL_COMPLETE_FLAG), "Crawling complete");
    }

    await sendEmail();
};


if (isMainThread) {
    // Main thread code
    const main = async () => {
        let resultados;
        let keepGoing = !(checkCloseToEmailBracketEnd(emailEndTime));

        while (keepGoing) {
            if (checkCloseToEmailBracketEnd(emailEndTime)) {
                keepGoing = false;
                break;
            }
            resultados = loadPreviousResults();
            const results = await crawlWebsites();
            for (const [term, articles] of Object.entries(results)) {
                resultados[term].push(...articles);
            }

            await saveResults(resultados);
        }

        if (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG))) {
            fs.writeFileSync(path.join(__dirname, CRAWL_COMPLETE_FLAG), "Crawling complete");
        }

        await sendEmail();
    };

    // Using IIFE to handle top-level await
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
    const { chunk, terms, seenLinks: initialSeenLinks } = workerData;
    let seenLinks = new Set(initialSeenLinks);

    (async () => {
        const results = {};
        for (const term of terms) results[term] = [];

        for (const url of chunk) {
            if (checkCloseToEmailBracketEnd(emailEndTime)) {
                parentPort.postMessage({ articles: results, seenLinks: Array.from(seenLinks) });
                return;
            }
            console.log(`Crawling ${url}...`);
            try {
                const websiteResults = await crawlWebsite(url, terms, seenLinks);
                for (const [term, articles] of Object.entries(websiteResults)) {
                    results[term].push(...articles);
                }
            } catch (error) {
                console.error(`Error crawling ${url}: ${error}`);
            }
        }
        parentPort.postMessage({ articles: results, seenLinks: Array.from(seenLinks) });
    })();
}