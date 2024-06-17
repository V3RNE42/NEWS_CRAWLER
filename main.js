const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio');
const { OpenAI } = require("openai");
const puppeteer = require('puppeteer');
const { terms, websites } = require("./terminos");
const config = require("./config.json");
const { getMainTopics } = require("./SENTIMENT_ANALYSIS/topics_extractor.js");
const { get } = require("http");

const openai = new OpenAI({ apiKey: config.openai.api_key });

const parseTime = (timeStr) => {
    const [hour, minute] = timeStr.split(":").map(Number);
    return { hour, minute };
};

const emailEndTime = parseTime(config.time.email);
const language = config.language;
let seenLinks = new Set();

const todayDate = () => new Date().toISOString().split("T")[0];

async function extractArticleText(url) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    const articleText = await page.evaluate(() => {
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
    return cleanText(articleText);
}

function cleanText(text) {
    const farewellMessages = [
        "Apúntate",
        "window._taboola",
        "Sección de comentarios",
        "Únete a la conversación",
        "COMPARTIR",
        "COMENTARIOS",
        "Comparte esta noticia en tus redes",
        "Comenta esta noticia"
    ];
    for (let message of farewellMessages) {
        const index = text.indexOf(message);
        if (index !== -1) {
            text = text.substring(0, index).trim();
            break;
        }
    }
    return text;
}

async function getOpenAIResponse(text, title, maxTokens) {
    const FULL_TEXT = text;
    const MAX_TOKENS_PER_CALL = 8000;
    function getPrompt(news_content, news_title) {
        return `Haz un resumen de la siguiente noticia:\n\n\n\n${news_content}\n\n\n\n`+
            `Ignora todo texto que no tenga que ver con el titular de la noticia: ${news_title}`;
    }

    try {
        const chunks = splitTextIntoChunks(FULL_TEXT, MAX_TOKENS_PER_CALL);
        let respuesta = "";

        for (const chunk of chunks) {
            let content = getPrompt(chunk, title);
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

function splitTextIntoChunks(text, maxTokens) {
    const tokens = text.split(/\s+/);
    const chunks = [];
    let currentChunk = "";

    for (const token of tokens) {
        if ((currentChunk + " " + token).length <= maxTokens) {
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

// async function getOpenAIResponse(text, title, maxTokens) {
//     text = text.substring(0, 7800);
//     text = `Haz un resumen de la siguiente noticia:\n\n\n\n${text}\n\n\n\nIgnora todo texto que no tenga que ver con el titular de la noticia: ${title}`;
//     try {
//         const response = await openai.chat.completions.create({
//             model: "gpt-4",
//             messages: [{ role: "user", content: text }],
//             stream: true,
//             max_tokens: maxTokens,
//             temperature: 0.1,
//             top_p: 0.1,
//             frequency_penalty: 0.0,
//             presence_penalty: 0.0,
//         });
//         let respuesta = "";
//         for await (const chunk of response) {
//             respuesta += chunk.choices[0]?.delta?.content || "";
//         }
//         return respuesta;
//     } catch (error) {
//         console.error('Error in OpenAI response:', error);
//         return "";
//     }
// }

async function getProxiedContent(link) {
    try {
        console.log(`Let's go with the proxy for ${link} ...`);
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        await page.goto('https://12ft.io/', { waitUntil: 'domcontentloaded' });
        await page.type('input.px-4.w-\\[300px\\].border.border-gray-400.border-r-0', link);
        await page.click('button.px-4.py-2.min-w-12.text-sm.leading-none.font-medium.border.border-yellow-500.bg-yellow-100.text-yellow-700.hover\\:bg-yellow-200');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        const content = await page.evaluate(() => document.body.innerText);
        await browser.close();
        return content;
    } catch (error) {
        console.error('Error in fetching proxied content:', error);
        return "";
    }
}

const summarizeText = async (link, numberOfLinks, title) => {
    let text = await extractArticleText(link);
    let maxTokens = 150 + Math.ceil(300 / numberOfLinks);
    let response = "";
    let count = 0;

    while (response === "") {
        if (count == 0) {
            response = await getOpenAIResponse(text, title, maxTokens);
        } else if (count == 1) {
            console.log("Article may be behind a PayWall...");
            text = await getProxiedContent(link);
            response = await getOpenAIResponse(text, title, maxTokens);
        } else {
            response = "No se pudo generar un resumen";
        }
        count++;
    }

    return response;
};

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

const checkCloseToEmailBracketEnd = (endTime) => {
    const now = new Date();
    const end = new Date();
    end.setHours(endTime.hour, endTime.minute, 0, 0);
    const tenMinutesBeforeEnd = new Date(end.getTime() - 20 * 60000);
    return now >= tenMinutesBeforeEnd && now < end;
};

const crawlWebsite = async (url, terms) => {
    let results = {};

    terms.forEach((term) => { results[term] = []; }); //initialize every term in the results object
    for (const term of terms) {
        const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(term)}+site:${encodeURIComponent(url)}&freshness=Day`;
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
                    let articleContent = await extractArticleText(link);
                    let { score, mostCommonTerm } = relevanceScoreAndMaxCommonFoundTerm(articleContent);
                    if (score > 0) {
                        let topics = getMainTopics(articleContent, language); //discard false positive
                        if (topics.some(topic => terms.includes(topic))) {
                            seenLinks.add(link);
                            const summary = "placeholder";
                            results[mostCommonTerm].push({ title, link, summary, score, term: mostCommonTerm });
                            console.log(`Found article: ${title} - ${link}`);
                        }
                    }
                }
            }
        }
    }

    return results;
};

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

const saveResults = async (results) => {
    console.log("Saving results...");
    const resultsPath = path.join(__dirname, `crawled_results.json`);
    const flagPath = path.join(__dirname, "crawl_complete.flag");
    let topArticles = [];
    let numTopArticles = 0;
    let mostCommonTerm = "Most_Common_Term";
    const thisIsTheTime = checkCloseToEmailBracketEnd(emailEndTime);
    if (thisIsTheTime) {
        topArticles = extractTopArticles(results);
        numTopArticles = topArticles.length;
        for (let i = 0; i < numTopArticles; i++) {
            topArticles[i].summary = await summarizeText(topArticles[i].link, numTopArticles, topArticles[i].title);
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

const loadPreviousResults = () => {
    console.log("Loading previous results...");
    const resultsPath = path.join(__dirname, `crawled_results.json`);
    if (fs.existsSync(resultsPath)) {
        const previousResults = JSON.parse(fs.readFileSync(resultsPath));
        seenLinks = new Set();
        for (const articles of Object.values(previousResults.results)) {
            articles.forEach(article => seenLinks.add(article.link));
        }
        fs.unlinkSync(resultsPath);
        return previousResults.results;
    } else {
        let previous_results = {};
        terms.forEach((term)=>{ previous_results[term] = [] })
        return previous_results;
    }
};

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

const loadResults = () => {
    console.log("Loading results...");
    const resultsPath = path.join(__dirname, `crawled_results.json`);
    if (fs.existsSync(resultsPath)) {
        return JSON.parse(fs.readFileSync(resultsPath));
    }
    return null;
};

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

    let emailBody = `Estas son las ${totalLinks} noticias frescas de ${todayDate()} :<br><br>`;
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
    console.log(`Webcrawler scheduled to run indefinetely. Emails will be sent daily at ${config.time.email}`);
    
    while (true) {
        console.log(`Running the web crawler at ${new Date().toISOString()}...`);
        await main()
            .then(() => console.log('Scheduled webcrawler run finished successfully\n\n\n'))
            .catch(error => console.error('Error in scheduled webcrawler run:', error, '\n\n\n'));
    };
})();
