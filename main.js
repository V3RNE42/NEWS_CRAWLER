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
const MAX_RETRIES_PER_FETCH = 3; //to be managed by user configuration
const ONE_MINUTE = 60000;
const FIVE_MINUTES = 5 * ONE_MINUTE; //to be managed by user configuration
const MINUTES_TO_CLOSE = 15 * ONE_MINUTE;
let FALSE_ALARM = false;
let BROWSER_PATH;

const STRING_PLACEHOLDER = "placeholder";
const FAILED_SUMMARY_MSSG = "No se pudo generar un resumen";
const EMPTY_STRING = "";
const CRAWLED_RESULTS_JSON = "crawled_results.json";
const CRAWL_COMPLETE_FLAG = "crawl_complete.flag";
const CRAWL_COMPLETE_TEXT = "Crawling completed!";
const MOST_COMMON_TERM = "Most_Common_Term";

class Lock {
    constructor() {
        this._locked = false;
        this._waiting = [];
    }

    async acquire() {
        const unlock = () => {
            let nextResolve;
            if (this._waiting.length > 0) {
                nextResolve = this._waiting.shift();
            } else {
                this._locked = false;
            }
            return nextResolve && nextResolve(unlock);
        };

        if (this._locked) {
            return new Promise(resolve => this._waiting.push(resolve));
        } else {
            this._locked = true;
            return Promise.resolve(unlock);
        }
    }
}

let addedLinks = new Set();
const lock = new Lock();
terms = terms.map((term) => term.toLowerCase());

const parseTime = (timeStr) => {
    const [hour, minute] = timeStr.split(":").map(Number);
    return { hour, minute };
};

let emailEndTime = parseTime(config.time.email);

//FUNCTIONS
/** Assigns a valid browser path to the BROWSER_PATH variable based on the configuration
 * @return {Promise<void>} A promise that resolves when the browser path is assigned.   */
async function assignBrowserPath() {
    BROWSER_PATH = config.browser.path === STRING_PLACEHOLDER
        ? await findValidChromiumPath()
        : config.browser.path;
}

const todayDate = () => new Date().toISOString().split("T")[0];

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
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            executablePath: BROWSER_PATH
        });
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: FIVE_MINUTES });

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

            return mainElement.innerText;
        });

        await browser.close();

        if (articleText === EMPTY_STRING) {
            const response = await fetch(url);
            const html = await response.text();
            const $ = cheerio.load(html);
            articleText = $.html();
        }

        return cleanText(articleText);
    } catch (error) {
        console.error(`Error extracting text from ${url}: ${error.message}`);
        return EMPTY_STRING;
    }
}

/** Cleans the given text by removing HTML tags and trimming whitespace
 * @param {string} text - The text to be cleaned.
 * @return {string} The cleaned text.     */
const cleanText = (text) => {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: [] });
    
    while (text.includes("\n\n")) {
        text = text.replace(/\n\n/g, '\n');
    }
    while (text.includes('  ')) {
        text = text.replace(/'  '/g, ' ');
    }

    while (text.includes("\t\t")) {
        text = text.replace(/\t\t/g, '\t');
    }

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
const isRecent = (dateText) => {
    if (!dateText) return false;

    const now = new Date();
    let date;

    // Handle relative time in both Spanish and English
    const relativeMatchES = dateText.match(/hace (\d+) (minutos?|horas?|días?|semanas?|meses?)/i);
    const relativeMatchEN = dateText.match(/(\d+) (minute|hour|day|week|month)s? ago/i);

    if (relativeMatchES || relativeMatchEN) {
        const [_, amount, unit] = relativeMatchES || relativeMatchEN;
        date = new Date(now);
        switch(unit.toLowerCase()) {
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
        // Handle absolute dates (including Spanish, English, and European formats)
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
            "d 'de' MMM'. de' yyyy"
        ];
        
        for (const format of formats) {
            // Try parsing with Spanish locale
            date = parse(dateText, format, new Date(), { locale: es });
            if (!isNaN(date)) break;

            // If Spanish fails, try English locale
            date = parse(dateText, format, new Date(), { locale: enUS });
            if (!isNaN(date)) break;
        }

        // If standard parsing fails, try custom parsing for abbreviated Spanish months
        if (isNaN(date)) {
            const spanishMonthAbbr = {
                'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
                'jul': 6, 'ago': 7, 'sept': 8, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
            };

            const match = dateText.match(/(\d{1,2}) de (\w{3,5})\. de (\d{4})/);
            if (match) {
                const [_, day, monthAbbr, year] = match;
                const month = spanishMonthAbbr[monthAbbr.toLowerCase()];
                if (month !== undefined) {
                    date = new Date(parseInt(year), month, parseInt(day));
                }
            }
        }

        if (isNaN(date)) {
            console.warn(`Could not parse date: ${dateText}`);
            return false;
        }
    }

    return differenceInHours(now, date) < 24;
};

async function fetchWithRetry(url, retries = MAX_RETRIES_PER_FETCH, initialDelay = ONE_MINUTE/60, timeout = FIVE_MINUTES) {
    for (let i = 0; i < retries; i++) {
        try {
            await limiter.removeTokens(1);

            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                timeout: timeout
            });
            return response.data;
        } catch (error) {
            if (i === retries - 1) throw error;
            
            const delay = initialDelay * Math.pow(2, i);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
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
 * @param {Object} emailEndTime - An object containing the hour and minute of the end time.
 * @param {number} emailEndTime.hour - The hour of the end time.
 * @param {number} emailEndTime.minute - The minute of the end time.
 * @return {boolean} Returns true if the current time is within 15 minutes of the end time, false otherwise.    */
const closeToEmailingTime = () => {
    const now = new Date();
    const end = new Date();
    end.setHours(emailEndTime.hour, emailEndTime.minute, 0, 0);
    const tenMinutesBeforeEnd = new Date(end.getTime() - MINUTES_TO_CLOSE);
    return now >= tenMinutesBeforeEnd && now < end;
};

const limiter = new RateLimiter({ tokensPerInterval: 1, interval: "second" });

class WorkerManager {
    constructor(maxWorkers) {
        this.maxWorkers = maxWorkers;
    }

    createWorkerPromise(workerData, index) {
        return new Promise((resolve) => {
            const worker = new Worker(__filename, { workerData });
            
            const timeout = setTimeout(() => {
                console.warn(`Worker ${index} timed out`);
                worker.terminate();
                resolve({ status: 'timeout' });
            }, INITIAL_DELAY0); // 5 minute timeout

            worker.on('message', (message) => {
                clearTimeout(timeout);
                if (message.type === 'result') {
                    console.log(`Worker ${index} completed`);
                    resolve({ status: 'fulfilled', value: message.result });
                }
            });

            worker.on('error', (error) => {
                clearTimeout(timeout);
                console.error(`Worker ${index} error:`, error);
                resolve({ status: 'rejected', reason: error });
            });

            worker.on('exit', (code) => {
                clearTimeout(timeout);
                if (code !== 0) {
                    console.warn(`Worker ${index} stopped with exit code ${code}`);
                    resolve({ status: 'rejected', reason: `Exit code ${code}` });
                }
            });
        });
    }

    async runAll(workersData) {
        console.log(`Running ${workersData.length} chunks on ${this.maxWorkers} workers`);
        
        const workerPromises = workersData.map((data, index) => 
            this.createWorkerPromise(data, index)
        );

        const results = await Promise.allSettled(workerPromises);
        return results.map(result => result.value).filter(result => result.status === 'fulfilled').map(result => result.value);
    }
}

async function crawlWebsite(url, terms, workerAddedLinks, newlyAddedLinks) {
    let results = {};
    terms.forEach(term => results[term] = []);

    console.log(`Crawling ${url}...`);

    const termPromises = terms.map(async (term) => {
        try {
            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}+site:${encodeURIComponent(url)}&filters=ex1%3a"ez5"`;
            const html = await fetchWithRetry(searchUrl);
            const $ = cheerio.load(html);

            const articleElements = $("li.b_algo");

            const articlePromises = articleElements.map(async (_, article) => {
                const titleElement = $(article).find("h2");
                const linkElement = titleElement.find("a");
                const dateElement = $(article).find("span.news_dt");

                if (titleElement.length && linkElement.length && dateElement.length) {
                    const title = titleElement.text().trim();
                    const link = normalizeUrl(linkElement.attr("href"));
                    const dateText = dateElement.text().trim();

                    if (!isWebsiteValid(url, link)) return null;

                    const unlock = await lock.acquire();
                    try {
                        if (!workerAddedLinks.has(link) && !newlyAddedLinks.has(link)) {
                            if (isRecent(dateText)) {
                                let articleContent;
                                try {
                                    articleContent = await extractArticleText(link);
                                } catch (error) {
                                    console.error(`Error extracting text from ${link}: ${error.message}`);
                                    return null;
                                }

                                const { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(title + ' ' + articleContent);

                                if (score > 0) {
                                    workerAddedLinks.add(link);
                                    newlyAddedLinks.add(link);

                                    console.log(`Added article! - ${link}`);

                                    return {
                                        title: title,
                                        link: link,
                                        summary: STRING_PLACEHOLDER,
                                        score: score,
                                        term: mostCommonTerm,
                                        fullText: articleContent,
                                        date: dateText
                                    };
                                }
                            }
                        }
                    } finally {
                        unlock();
                    }
                }
                return null;
            }).get();

            const articleResults = await Promise.allSettled(articlePromises);
            const validArticles = articleResults
                .filter(result => result.status === 'fulfilled' && result.value !== null)
                .map(result => result.value);

            results[term].push(...validArticles);

        } catch (error) {
            console.error(`Error crawling ${url} for term ${term}: ${error.message}`);
            if (error.response) {
                console.error(`Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}`);
            }
        }
    });

    await Promise.allSettled(termPromises);

    for (const [term, articles] of Object.entries(results)) {
        console.log(`Found ${articles.length} articles for term "${term}"`);
    }

    return results;
}

/**
 * Splits an array into a specified number of chunks.
 *
 * @param {Array} array - The array to be split into chunks.
 * @param {number} numChunks - The number of chunks to create.
 * @return {Array<Array>} An array of chunks, each containing a portion of the original array.  */
const chunkArray = (array, chunkSize) => {
    if (!Array.isArray(array) || !array.length) {
        return [];
    }
    let chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
};

function isWebsiteValid(baseUrl, fullLink) {
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

/**
 * Crawls multiple websites for articles related to specified terms.
 *
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
const crawlWebsites = async () => {
    let allResults = {};
    for (const term of terms) allResults[term] = [];

    const maxConcurrentWorkers = os.cpus().length;
    console.log(`Using ${maxConcurrentWorkers} concurrent workers`);

    if (!Array.isArray(websites) || websites.length === 0) {
        console.error("No websites to crawl!");
        return allResults;
    }

    const websiteChunks = chunkArray(websites, Math.ceil(websites.length / maxConcurrentWorkers));
    console.log(`Created ${websiteChunks.length} website chunks`);
    websiteChunks.forEach((chunk, index) => {
        console.log(`Chunk ${index + 1}: ${chunk.join(', ')}`);
    });

    const manager = new WorkerManager(maxConcurrentWorkers);
    
    console.log("Crawling websites...");
    const results = await manager.runAll(websiteChunks.map(chunk => ({ websites: chunk, terms, addedLinks: Array.from(addedLinks) })));
    console.log("All workers have completed. Processing results...");

    console.log(`Received results from ${results.length} successful workers`);

    for (const result of results) {
        for (const [term, articles] of Object.entries(result.articles)) {
            allResults[term].push(...articles);
        }
        result.addedLinks.forEach(link => addedLinks.add(link));
    }

    console.log("Finished processing all results");
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

/**
 * Arranges the articles from the given results object based on their terms.
 *
 * @param {Object} results - An object containing articles grouped by terms.
 * @return {Promise<Object>} - A promise that resolves to an object with articles reorganized by term */
async function removeIrrelevantArticles(results) {
    let reorganizedResults = {};

    // Initialize reorganizedResults with all terms from the original results
    for (const term of Object.keys(results)) {
        reorganizedResults[term] = [];
    }

    for (const [term, articles] of Object.entries(results)) {
        for (let article of articles) {
            if (article.fullText === EMPTY_STRING) {
                try {
                    article.fullText = await extractArticleText(article.link);
                } catch (error) {
                    console.error(`Error extracting text from ${article.link}: ${error.message}`);
                    continue; // Skip this article if text extraction fails
                }
            }

            let title = article.title;
            let textToAnalyze = title.concat(' ',article.fullText);

            let mainTopics = getMainTopics(textToAnalyze, LANGUAGE, SENSITIVITY);
            if (!mainTopics.some(topic => terms.includes(topic.toLowerCase())) && article.score === 1) {
                console.log(`Irrelevant article discarded: ${article.link}`);
                continue; // Skip this article if it's not relevant
            }

            reorganizedResults[term].push(article);
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
    let mostCommonTerm = MOST_COMMON_TERM;
    let link = EMPTY_STRING, summary = EMPTY_STRING;

    const thisIsTheTime = closeToEmailingTime();
    if (thisIsTheTime) {
        results = await removeIrrelevantArticles(results);
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
    if (thisIsTheTime && !(FALSE_ALARM)) {
        fs.writeFileSync(flagPath, CRAWL_COMPLETE_TEXT);
        console.log(CRAWL_COMPLETE_TEXT)
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

            for (const articles of Object.values(previousResults.results)) {
                articles.forEach(article => addedLinks.add(article.link));
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
                topArticles[i].term,
                topArticles[i].title
            ));
            topArticles[i].summary = summary;
            topArticles[i].link = link !== EMPTY_STRING ? link : topArticles[i].link;
        }
    }

    while (emailTime.getTime() > Date.now()) {
        console.log("Waiting...");
        await new Promise((r) => setTimeout(r, ONE_MINUTE * 1.5));
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


/**
 * Asynchronous main function that handles interrupt signals, saves results, crawls websites, and sends emails.
 *
 * @return {Promise<void>} Promise that resolves when all operations are completed. */
const main = async () => {
    //Ctrl+C triggers saving results -> Helps the testing by the developer
    process.on('SIGINT', async () => {
        console.log(`Caught interrupt signal (Ctrl+C)\nSetting emailEndTime in ${(MINUTES_TO_CLOSE/ONE_MINUTE) - 1} minutes from now`);
        const now = new Date();
        emailEndTime = new Date(now.getTime() + MINUTES_TO_CLOSE - ONE_MINUTE);
        FALSE_ALARM = true;
        await saveResults(resultados);
    });

    let resultados;
    let keepGoing = !(closeToEmailingTime());

    while (keepGoing && !fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG))) {
        keepGoing = closeToEmailingTime();

        resultados = loadPreviousResults();
        let results = await crawlWebsites();

        console.log(Object.entries(results));

        for (let [term, articles] of Object.entries(results)) {
            resultados[term].push(...articles);
        }

        await saveResults(resultados);
    }

    if (!fs.existsSync(path.join(__dirname, CRAWL_COMPLETE_FLAG)) && !(FALSE_ALARM)) {
        fs.writeFileSync(path.join(__dirname, CRAWL_COMPLETE_FLAG), CRAWL_COMPLETE_TEXT);
    }

    await sendEmail();
};

if (isMainThread) {
    // Main thread code
    (async () => {
        try {
            await assignBrowserPath();
            console.log(`Webcrawler scheduled to run indefinitely. Emails will be sent daily at ${config.time.email}`);
    
            while (true) {
                console.log(`Running the web crawler at ${new Date().toISOString()}...`);
                
                const crawlPromise = main()
                    .then(() => console.log('Scheduled webcrawler run finished successfully\n\n\n'))
                    .catch(error => console.error('Error in scheduled webcrawler run:', error, '\n\n\n'));
    
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Crawl timed out')), websites.length * ONE_MINUTE * 2)
                );
    
                await Promise.race([crawlPromise, timeoutPromise]);
                
                await new Promise(resolve => setTimeout(resolve, ONE_MINUTE)); // 1 minute delay between runs
            }
        } catch (error) {
            console.error("Critical error in main execution:", error);
        }
    })();
} else {
    // Worker thread code
    (async () => {
        try {
            const { websites, terms, addedLinks: initialAddedLinks } = workerData;
            console.log(`Worker started with ${websites.length} websites`);
            let workerAddedLinks = new Set(initialAddedLinks);

            const results = {};
            for (const term of terms) results[term] = new Set();

            const newlyAddedLinks = new Set();

            const websitePromises = websites.map(async (website) => {
                try {
                    console.log(`Worker processing website: ${website}`);
                    const websiteResults = await crawlWebsite(website, terms, workerAddedLinks, newlyAddedLinks);
                    for (const [term, articles] of Object.entries(websiteResults)) {
                        articles.forEach(article => results[term].add(article));
                    }
                    return { status: 'fulfilled' };
                } catch (error) {
                    console.error(`Error crawling ${website}:`, error);
                    return { status: 'rejected', reason: error.message };
                }
            });

            await Promise.allSettled(websitePromises);

            console.log(`Worker finished processing ${websites.length} websites`);

            parentPort.postMessage({
                type: 'result',
                result: {
                    articles: Object.fromEntries(Object.entries(results).map(([term, articles]) => [term, Array.from(articles)])),
                    addedLinks: Array.from(newlyAddedLinks)
                }
            });
        } catch (error) {
            console.error('Worker error:', error);
            parentPort.postMessage({ type: 'error', error: error.message });
        } finally {
            parentPort.close();
        }
    })();
}