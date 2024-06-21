//MODULES AND IMPORTS
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio');
const { OpenAI } = require("openai");
const puppeteer = require('puppeteer');
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
let BROWSER_PATH;

const SUMMARY_PLACEHOLDER = "placeholder";
const FAILED_SUMMARY_MSSG = "No se pudo generar un resumen";

let seenLinks = new Set();
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
    BROWSER_PATH = config.browser.path === "placeholder" 
        ? await findValidChromiumPath() 
        : config.browser.path;
}

const todayDate = () => new Date().toISOString().split("T")[0];

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

    if (articleText === "") {
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

async function getChunkedOpenAIResponse(text, title, maxTokens) {
    /** Generates a prompt for OpenAI to generate a summary of a specific part of a news article.
     * @param {string} news_content - The content of the news article.
     * @param {string} news_title - The title of the news article.
     * @param {number} current - The current part number of the news article being summarized.
     * @param {number} total - The total number of parts in the news article.
     * @return {string} The generated prompt for OpenAI.                                            */
    function getPrompt(news_content, news_title, current, total) {
        return `Haz un resumen del siguiente fragmento que cubre la parte ${current} de ${total}` +
            `de la siguiente noticia:\n\n\n\n${news_content}\n\n\n\n` +
            `Ignora todo texto que no tenga que ver con el titular de la noticia: ${news_title}`;
    }

    try {
        const chunks = splitTextIntoChunks(text);
        let respuesta = "";
        maxTokens = Math.floor(maxTokens / chunks.length);

        for (let i = 0; i < chunks.length; i++) {
            let content = getPrompt(chunks[i], title, (i + 1), chunks.length);
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
                respuesta += chunkResponse.choices[0]?.delta?.content || "";
            }
        }

        return respuesta;
    } catch (error) {
        console.error('Error in OpenAI response:', error);
        return "";
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
    let currentChunk = "";

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

async function getNonChunkedOpenAIResponse(text, title, maxTokens) {
    text = `Haz un resumen de la siguiente noticia:\n\n\n\n${text}\n\n\n\nIgnora todo texto que no tenga que ver con el titular de la noticia: ${title}`;
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
        let respuesta = "";
        for await (const chunk of response) {
            respuesta += chunk.choices[0]?.delta?.content || "";
        }
        return respuesta;
    } catch (error) {
        console.error('Error in OpenAI response:', error);
        return "";
    }
}


/**
 * Retrieves an OpenAI response for the given text and title.
 *
 * @param {string} text - The text to be summarized.
 * @param {string} title - The title of the news article.
 * @param {number} maxTokens - The maximum number of tokens allowed in the response.
 * @return {Promise<string>} A promise that resolves to the OpenAI response. If the text is empty or the title is empty, an empty string is returned. If the number of tokens in the text exceeds the maximum allowed tokens per call, the function calls getChunkedOpenAIResponse to handle the text in chunks. 
 * Otherwise, it calls getNonChunkedOpenAIResponse to generate the response.  */
async function getOpenAIResponse(text, title, maxTokens) {
    if (text == "" || title == "") {
        return "";
    }

    if (countTokens(text) >= MAX_TOKENS_PER_CALL) {
        return getChunkedOpenAIResponse(text, title, maxTokens);
    }

    return getNonChunkedOpenAIResponse(text, title, maxTokens);
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
        return { url: "", content: "" };
    }
}

/**
 * Retrieves a summary of the text from the given link using OpenAI's GPT-4 model.
 *
 * @param {string} link - The URL of the webpage.
 * @param {number} numberOfLinks - The total number of links under the same TERM search.
 * @param {string} title - The title of the news article.
 * @return {Promise<{url: string, response: string}>} A promise that resolves to an object containing the summary of the text and the valid URL.  */
const summarizeText = async (link, numberOfLinks, title) => {
    let text = await extractArticleText(link);
    let maxTokens = 150 + Math.ceil(300 / numberOfLinks);
    let response = "";
    let count = 0;
    let url = link;

    while ((response === "" || countTokens(text) < 150) && count < 3) {
        if (count === 0) {
            response = await getOpenAIResponse(text, title, maxTokens);
        } else if (count === 1) {
            ({ url, content: text } = await getProxiedContent(link));
            response = await getOpenAIResponse(text, title, maxTokens);
        } else {
            response = FAILED_SUMMARY_MSSG;
        }
        count++;
    }

    return { url, response };
};

/**
 * Checks if a given date text is recent.
 *
 * @param {string} dateText - The text to be checked.
 * @return {boolean} Returns true if the date text is recent, false otherwise.  */
const isRecent = (dateText) => {
    const today = new Date();
    const todayStr = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

    return (
        ["hours ago", "hour ago", "minutes ago", "minute ago", "just now", "hora", "horas", "minuto", "minutos", "segundos", "justo ahora"]
            .some((keyword) => dateText.toLowerCase().includes(keyword)) ||
        dateText.includes(todayStr)
    );
};

const fetchPage = async (url, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok)
                throw new Error(`HTTP error! status: ${response.status}`);
            return await response.text();
        } catch (error) {
            console.warn(`Attempt ${i + 1} for URL ${url} failed: ${error}`);
            await new Promise((r) => setTimeout(r, 2 ** i * 800));
        }
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 600)));
    }
    console.error(`All retries failed for URL ${url}`);
    return null;
};

/**
 * Calculate the relevance score and find the most common term in the given text.
 *
 * @param {string} text - The text to analyze.
 * @return {object} An object containing the score and the most common term.    */
const relevanceScoreAndMaxCommonFoundTerm = (text) => {
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

/**
 * Crawls a website for articles related to given terms and returns the results.
 *
 * @param {string} url - The URL of the website to crawl.
 * @param {Array<string>} terms - An array of terms to search for.
 * @return {Promise<Object>} An object containing the results of the crawl, with each term as a key and an array of matching articles as the value. */
const crawlWebsite = async (url, terms) => {
    let results = {};

    terms.forEach((term) => { results[term] = []; }); //initialize every term in the results object
    for (const term of terms) {
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}+site:${encodeURIComponent(url)}&filters=ex1%3a"ez5"`;
        const pageContent = await fetchPage(searchUrl);
        if (!pageContent) continue;

        const $ = cheerio.load(pageContent);
        const articleElements = $("li.b_algo");

        for (let i = 0; i < articleElements.length; i++) {
            if (checkCloseToEmailBracketEnd(emailEndTime)) {
                console.log("Stopping crawling to prepare for email sending.");
                return results;
            }

            const article = articleElements[i];
            const titleElement = $(article).find("h2");
            const linkElement = titleElement.find("a");
            const dateElement = $(article).find("span.news_dt");

            if (titleElement && linkElement && dateElement) {
                const title = titleElement.text();
                const link = normalizeUrl(linkElement.attr("href"));
                const dateText = dateElement.text();

                if (seenLinks.has(link) || link === url) continue;

                if (isRecent(dateText)) {
                    let fullText = await extractArticleText(link);
                    let { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(fullText);
                    if (score > 0) {
                        let topics = getMainTopics(fullText, LANGUAGE, SENSITIVITY); //discard false positive
                        if (topics.some(topic => terms.includes(topic.toLowerCase()))) {
                            seenLinks.add(link);
                            const summary = SUMMARY_PLACEHOLDER;
                            results[mostCommonTerm].push({ title, link, summary, score, term: mostCommonTerm, fullText });
                            console.log(`Found article: ${title} - ${link}`);
                        }
                    }
                }
            }
        }
    }

    return results;
};

/**
 * Crawls multiple websites for articles related to specified terms.
 *
 * @return {Promise<Object>} An object containing arrays of articles for each term. */
const crawlWebsites = async () => {
    const allResults = {};
    for (const term of terms) allResults[term] = [];

    for (const url of websites) {
        if (checkCloseToEmailBracketEnd(emailEndTime)) {
            console.log("Stopping crawling to prepare for email sending.");
            return allResults;
        }
        console.log(`Crawling ${url}...`);
        await new Promise((r) => setTimeout(r, (550 + Math.floor(Math.random() * 600))));
        try {
            const results = await crawlWebsite(url, terms);
            for (const [term, articles] of Object.entries(results)) {
                for (const art of articles) {
                    allResults[term].push(art);
                    console.log(`Added article: ${art.title} (${art.link})`);
                }
            }
            await new Promise((r) => setTimeout(r, (1000 + Math.floor(Math.random() * 250))));
        } catch (error) {
            console.error(`Error crawling ${url}: ${error}`);
        }
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

/**
 * Saves the results to a JSON file.
 *
 * @param {Object} results - The results to be saved.
 * @return {Promise<boolean>} - A promise that resolves to a boolean indicating if the crawling is complete.    */
const saveResults = async (results) => {
    console.log("Saving results...");
    const resultsPath = path.join(__dirname, `crawled_results.json`);
    const flagPath = path.join(__dirname, "crawl_complete.flag");
    let topArticles = [];
    let numTopArticles = 0;
    let mostCommonTerm = "Most_Common_Term";
    let link = "", summary = "";
    
    const thisIsTheTime = checkCloseToEmailBracketEnd(emailEndTime);
    if (thisIsTheTime) {
        results = await removeRedundantArticles(results);
        topArticles = extractTopArticles(results);
        numTopArticles = topArticles.length;
        for (let i = 0; i < numTopArticles; i++) {
            if (topArticles[i].summary === SUMMARY_PLACEHOLDER || 
                topArticles[i].summary.includes(FAILED_SUMMARY_MSSG)) {
                ({ url: link, response: summary } = await summarizeText(topArticles[i].link, numTopArticles, topArticles[i].title));
                topArticles[i].summary = summary;
                topArticles[i].link = link !== "" ? link : topArticles[i].link;
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
 *
 * @return {Object} The previous results, or an empty object if the file doesn't exist. */
const loadPreviousResults = () => {
    console.log("Loading previous results...");
    const resultsPath = path.join(__dirname, `crawled_results.json`);
    if (fs.existsSync(resultsPath)) {
        const previousResults = JSON.parse(fs.readFileSync(resultsPath));
        seenLinks = new Set();
        for (const articles of Object.values(previousResults.results)) {
            articles.forEach(article => seenLinks.add(article.link));
        }
        return previousResults.results;
    } else {
        let previous_results = {};
        terms.forEach((term) => { previous_results[term] = [] })
        return previous_results;
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
    const resultsPath = path.join(__dirname, `crawled_results.json`);
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

    while (!fs.existsSync(path.join(__dirname, "crawl_complete.flag")) || emailTime.getTime() > Date.now()) {
        await new Promise((r) => setTimeout(r, 60000));
    }

    const results = loadResults();
    const sender = config.email.sender;
    const recipients = config.email.recipients;
    const totalLinks = Object.values(results.results).flat().length ?? 0;
    const sortedResults = Object.entries(results.results).sort((a, b) => b[1].length - a[1].length) ?? [];

    const mostFrequentTerm = results.mostCommonTerm ?? "";
    const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
    let topArticles = results.topArticles ?? [];
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
        emailBody += `<b>NO encontré noticias relevantes hoy</b>`;
    }

    emailBody += "<br>"

    sortedResults.forEach(([term, articles]) => {
        if (articles.length) {
            emailBody += `<b>${term.toUpperCase()} - ${articles.length} link${articles.length === 1 ? "" : "s"}</b><br>`;
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

        fs.unlinkSync(path.join(__dirname, "crawl_complete.flag"));
        fs.unlinkSync(path.join(__dirname, `crawled_results.json`));
        console.log("Cleanup complete: Deleted flag and results files.");
    } catch (error) {
        console.error(`Error sending emails: ${error}`);
    }
};

const main = async () => {
    let proceedToSendEmail;
    let resultados;
    while (true) {
        resultados = loadPreviousResults();
        const results = await crawlWebsites();
        for (const [term, articles] of Object.entries(results)) {
            resultados[term].push(...articles);
        }
        proceedToSendEmail = await saveResults(resultados);
        if (checkCloseToEmailBracketEnd(emailEndTime)) {
            console.log("Stopping crawling to prepare for email sending.");
            break;
        }
    }
    /**Edge case of checkCloseToEmailBracketEnd(emailEndTime) becoming true 
     * RIGHT AFTER saveResults(resultados), but BEFORE starting a new cycle   */
    if (!proceedToSendEmail) {
        await saveResults(resultados);
    }

    await sendEmail();
};


// Using IIFE to handle top-level await
(async () => {
    await assignBrowserPath();
    console.log(`Webcrawler scheduled to run indefinetely. Emails will be sent daily at ${config.time.email}`);

    while (true) {
        console.log(`Running the web crawler at ${new Date().toISOString()}...`);
        await main()
            .then(() => console.log('Scheduled webcrawler run finished successfully\n\n\n'))
            .catch(error => console.error('Error in scheduled webcrawler run:', error, '\n\n\n'));
    };
})();
