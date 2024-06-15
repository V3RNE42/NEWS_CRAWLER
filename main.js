const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio');
const schedule = require("node-cron");
const { terms, websites } = require("./terminos");
const config = require("./config.json");
const { OpenAI, Configuration } = require("openai");
const { JSDOM } = require('jsdom');

const openai = new OpenAI({ apiKey: config.openai.api_key });

const todayDate = () => new Date().toISOString().split("T")[0];

/**
 * Extracts the main text content from the provided URL.
 *
 * @param {string} url - The URL from which to extract the main text content.
 * @return {string} The extracted main text content.      */
async function extractArticleText(url) {
  const fetch = (await import('node-fetch')).default;
  const response = await fetch(url);
  const html = await response.text();
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const mainSelectors = [
    'article',
    'main',
    'section',
    '.article-body',
    '.content',
    '.main-content',
    '.entry-content',
    '.post-content',
    '.story-body',
    '.news-article'
  ];
  let mainElement = null;
  for (let selector of mainSelectors) {
    mainElement = document.querySelector(selector);
    if (mainElement) break;
  }
  if (!mainElement) {
    console.error('Main content not found');
    return '';
  }

  /** Recursively extracts the text content from an HTML element and its child elements.
   *
   * @param {Node} element - The HTML element from which to extract the text content.
   * @return {string} The extracted text content.     */
  function getTextFromElement(element) {
    if (element.nodeType === dom.window.Node.TEXT_NODE) {
      return element.nodeValue.trim();
    }
    if (element.nodeType === dom.window.Node.ELEMENT_NODE) {
      let text = '';
      for (let child of element.childNodes) {
        text += ' ' + getTextFromElement(child);
      }
      return text.trim();
    }
    return '';
  }
  let articleText = getTextFromElement(mainElement);
  articleText = cleanText(articleText);
  return articleText;
}

/**
 * Cleans the given text by removing any farewell messages and trimming any leading or trailing whitespace.
 *
 * @param {string} text - The text to be cleaned.
 * @return {string} The cleaned text.       */
function cleanText(text) {
  const farewellMessages = [
    "Sigue toda la información de",
    "El análisis de la actualidad económica",
    "Apúntate",
    "Lo más visto",
    "Buscar bolsas y mercados",
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

/** Returns a summary of the pertinent content of the given link.
 *  @param {string} link 
 *  @returns {string}    */
const summarizeText = async (link, numberOfLinks, title) => {
  link = await extractArticleText(link);
  link = `Haz un resumen de la siguiente noticia:\n\n\n\n${link}\n\n\n\nIgnora todo texto que no tenga que ver con el titular de la noticia: ${title}`;
  let maxTokens = 150 + Math.ceil(300/numberOfLinks);
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: link }],
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
    console.error(`Error resumiendo el artículo: ${link}`, error);
    return "No se pudo generar un resumen";
  }
};

/**
 * Checks if a given date text is recent based on the current date.
 *
 * @param {string} dateText - The date text to check.
 * @return {boolean} Returns true if the date text is recent, false otherwise.  */
const isRecent = (dateText) => {
  const today = new Date();
  const todayStr = `${today.getMonth() + 1
    }/${today.getDate()}/${today.getFullYear()}`;

  return (
    ["hours ago", "hour ago", "minutes ago", "minute ago", "just now", "hora", "horas", "minuto", "minutos", "segundos", "justo ahora",]
      .some((keyword) => dateText.toLowerCase().includes(keyword)) ||
    dateText.includes(todayStr)
  );
};

/**
 * Asynchronously fetches a page from a specified URL with retry logic.
 *
 * @param {string} url - The URL to fetch the page from.
 * @param {number} retries - The number of retry attempts (default is 3).
 * @return {Promise<string>} A promise that resolves with the text content of the fetched page. */
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

/** Searches for a term within a text.
 * @param {string} text - The text to search within.
 * @param {string} term - The term to search for.
 * @returns {boolean} - Returns true if the term is found, otherwise false. */
function searchTermInText(text, term) {
  const escapedTerm = term.replace(/[*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
  return regex.test(text);
}

/** Calculates the relevance score of a text based on the search terms,
 *  and also finds the most common found term from 'terms'.
 *  @param {string} text - The text to calculate the relevance score for.
 *  @returns {Object} - An object containing the relevance score and the most common term  */
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

/**
 * Crawls a website for articles related to a list of search terms.
 *
 * @param {string} url - The URL of the website to crawl.
 * @param {Array<string>} terms - The list of search terms to search for.
 * @return {Promise<Object>} An object containing the results of crawling the website, 
 * where the keys are the search terms and the values are arrays of articles.         */
const crawlWebsite = async (url, terms) => {
  const results = {};

  for (const term of terms) {
    results[term] = [];
    const searchUrl = `https://www.bing.com/search?q=${term}+site:${url}&filters=ex1%3a"ez5"`;
    const pageContent = await fetchPage(searchUrl);
    if (!pageContent) continue;

    const $ = cheerio.load(pageContent);
    const articleElements = $("li.b_algo");

    for (let i = 0; i < articleElements.length; i++) {
      const article = articleElements[i];
      const titleElement = $(article).find("h2");
      const linkElement = titleElement.find("a");
      const dateElement = $(article).find("span.news_dt");

      if (titleElement && linkElement && dateElement) {
        const title = titleElement.text();
        const link = linkElement.attr("href");
        const dateText = dateElement.text();

        if (link === url) continue;

        if (isRecent(dateText)) {
          let articleContent = await extractArticleText(link);
          let {score, mostCommonTerm} = relevanceScoreAndMaxCommonFoundTerm(articleContent);
          if (score > 0) {
            const summary = "placeholder";
            results[mostCommonTerm].push({ title, link, summary, score, term: mostCommonTerm });
          }
        }
      }
    }
  }

  return results;
};

/**
 * Crawls a list of websites for articles related to a list of search terms.
 *
 * @return {Promise<Object>} An object containing the results of crawling the websites, 
 * where the keys are the search terms and the values are arrays of articles.       */
const crawlWebsites = async () => {
  const allResults = {};
  const seenLinks = new Set();
  for (const term of terms) allResults[term] = [];

  for (const url of websites) {
    console.log(`Crawling ${url}...`);
    await new Promise((r) => setTimeout(r, (550 + Math.floor(Math.random() * 600))));
    try {
      const results = await crawlWebsite(url, terms);
      for (const [term, articles] of Object.entries(results)) {
        for (const art of articles) {
          if (!seenLinks.has(art.link)) {
            console.log("Añadido nuevo artículo: " + art.title + " con enlace: " + art.link);
            seenLinks.add(art.link);
            allResults[term].push(art);
          }
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
 * Asynchronously saves the results to files, generates summaries for top articles, and writes the results and metadata to JSON files.
 *
 * @param {Object} results - The results object to be saved.
 * @return {void} This function does not return a value.      */
const saveResults = async (results) => {
  const resultsPath = path.join(__dirname, "crawled_results.json");
  const flagPath = path.join(__dirname, "crawl_complete.flag");
  const mostCommonTerm = mostCommonTerms(results);

  let topArticles = extractTopArticles(results);
  let numTopArticles = topArticles.length;

  // Ensure summaries are generated for all top articles
  for (let i = 0; i < numTopArticles; i++) {
    topArticles[i].summary = await summarizeText(topArticles[i].link, numTopArticles, topArticles[i].title);
  };

  const resultsWithTop = { results, topArticles, mostCommonTerm };

  fs.writeFileSync(resultsPath, JSON.stringify(resultsWithTop, null, 2));
  fs.writeFileSync(flagPath, "Crawling complete");
};

/**
 * Loads the results from the "crawled_results.json" file and returns them as a parsed JSON object.
 *
 * @return {Object} The parsed JSON object containing the results.    */
const loadResults = () => {
  const resultsPath = path.join(__dirname, "crawled_results.json");
  return JSON.parse(fs.readFileSync(resultsPath));
};

/**
 * Extracts the top articles from the given results based on their scores.
 *
 * @param {Object} results - The results object containing articles.
 * @return {Array} The top articles with the highest scores.              */
const extractTopArticles = (results) => {
  let allArticles = [];
  for (let articles of Object.values(results)) {
    allArticles.push(...articles);
  }
  allArticles.sort((a, b) => b.score - a.score);

  let potentialReturn = allArticles.slice(0, Math.floor(Math.sqrt(allArticles.length)));

  let totalScore = 0;
  for (let i = 0; i < allArticles.length; i++) totalScore += allArticles[i].score;
  let threshold = Math.floor(totalScore * 0.25);
  //extract the top articles whose total sum of scoreS is at least 25% of total score
  let topArticles = [];
  while (allArticles.length > 0 && threshold > 0) {
    threshold -= allArticles[0].score;
    topArticles.push(allArticles.shift());
  }
  
  return potentialReturn.length > topArticles.length ? potentialReturn : topArticles;
};

/**
 * Finds the most common terms in the given results object, 
 * based on the frequency of articles and their maximum scores.
 *
 * @param {Object} allResults - The results object containing the articles.
 * @return {string} - The most common terms separated by a forward slash.   */
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
 * Sends an email with the results of web crawling, including top articles and most frequent terms.
 *
 * @return {void} This function does not return a value.  */
const sendEmail = async () => {
  const emailTime = new Date();
  const [emailHour, emailMinute] = config.time.email.split(":");
  emailTime.setHours(emailHour, emailMinute, 0, 0);

  while (!fs.existsSync(path.join(__dirname, "crawl_complete.flag")) || emailTime.getTime() > Date.now()) {
    await new Promise((r) => setTimeout(r, 90000));
  }

  const results = loadResults();
  const sender = config.email.sender;
  const recipients = config.email.recipients;
  const totalLinks = Object.values(results.results).flat().length;
  const sortedResults = Object.entries(results.results).sort(
    (a, b) => b[1].length - a[1].length
  );
  const mostFrequentTerm = results.mostCommonTerm;
  const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
  let topArticles = results.topArticles;
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
    fs.unlinkSync(path.join(__dirname, "crawled_results.json"));
    console.log("Cleanup complete: Deleted flag and results files.");
  } catch (error) {
    console.error(`Error sending emails: ${error}`);
  }
};

/**
 * Schedules the web crawler to run at the specified time and sends emails with the results.
 *
 * @param {Object} config - The configuration object containing the crawling and email times.
 * @returns {void} This function does not return a value.       */
const main = async () => {
  while (config.time.crawl >= config.time.email) {
    console.log("Edita el archivo 'config.json' y cambia 'time.email' a una hora posterior a 'time.crawl' - No olvides reiniciar el servidor" + Date.now()) + "\n\n\n";
    await new Promise((r) => setTimeout(r, 60000));
  }
  const results = await crawlWebsites();
  await saveResults(results);
  await sendEmail();
};

schedule.schedule(`${config.time.crawl.split(':')[1]} ${config.time.crawl.split(':')[0]} * * *`, () => {
  console.log(`Running the web crawler at ${config['time']['crawl']} the day ${todayDate()}...`);
  main()
    .then(() => console.log('Webcrawler finished successfully\n\n\n'))
    .catch(error => console.error('Error in webcrawler:', error, "\n\n\n"));
});

console.log(
  `Webcrawler scheduled to run at ${config.time.crawl} and emails to be sent not before ${config.time.email} every day.`
);
