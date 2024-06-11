const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const cheerio = require('cheerio'); 
const schedule = require("node-cron");
const { terms, websites } = require("./terminos");
const config = require("./config.json");
const { OpenAI, Configuration } = require("openai");

const openai = new OpenAI({ apiKey: config.openai.api_key });

const todayDate = () => new Date().toISOString().split("T")[0];

/** Returns a summary of the content of the given link.
 *  @param {string} link 
 *  @returns {string}    */
const summarizeText = async (link) => {
  link = `Hazme un resumen de la siguiente noticia:\n\n${link}`;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: link }],
      stream: true,
      max_tokens: 250,
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

const isRecent = (dateText) => {
  const today = new Date();
  const todayStr = `${
    today.getMonth() + 1
  }/${today.getDate()}/${today.getFullYear()}`;

  return (
    ["hours ago","hour ago","minutes ago","minute ago","just now","hora","horas","minuto","minutos","segundos","justo ahora",]
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

/** Searches for a term within a text.
 * @param {string} text - The text to search within.
 * @param {string} term - The term to search for.
 * @returns {boolean} - Returns true if the term is found, otherwise false. */
function searchTermInText(text, term) {
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
  return regex.test(text);
}

const relevanceScore = (text) => terms.filter((term) => searchTermInText(text, term) ).length;

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
          let articleContent = await fetchPage(link);
          let score = relevanceScore(articleContent);
          if (score > 0) {
            const summary = "placeholder";
            results[term].push({ title, link, summary, score, term });
          }
        }
      }
    }
  }

  return results;
};

const crawlWebsites = async () => {
  const allResults = {};
  const seenLinks = new Set();
  for (const term of terms) allResults[term] = [];

  for (const url of websites) {
    console.log(`Crawling ${url}...`);
    await new Promise((r) => setTimeout(r, (550 +  Math.floor(Math.random() * 600))));
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
      await new Promise((r) => setTimeout(r, (1000 +  Math.floor(Math.random() * 250))));
    } catch (error) {
      console.error(`Error crawling ${url}: ${error}`);
    }
  }
  return allResults;
};

const saveResults = async (results) => {
  const resultsPath = path.join(__dirname, "crawled_results.json");
  const flagPath = path.join(__dirname, "crawl_complete.flag");
  const mostCommonTerm = mostCommonTerms(results);

  // Select the top articles and get remaining results
  const { top: topArticles, remainingResults } = selectTopSummaries(results);

  // Ensure summaries are generated for all top articles
  await Promise.all(topArticles.map(async (article) => {
    article.summary = await summarizeText(article.link);
  }));

  // Reconstruct the results object
  const resultsWithTop = { ...remainingResults, topArticles, mostCommonTerm };

  fs.writeFileSync(resultsPath, JSON.stringify(resultsWithTop, null, 2));
  fs.writeFileSync(flagPath, "Crawling complete");
};

const loadResults = () => {
  const resultsPath = path.join(__dirname, "crawled_results.json");
  return JSON.parse(fs.readFileSync(resultsPath));
};

const selectTopSummaries = (results) => {
  const allArticles = Object.values(results).flat();
  let numOfTopArticles = Math.floor(Math.sqrt(allArticles.length));

  allArticles.sort((a, b) => b.score - a.score);

  const topArticles = allArticles.slice(0, numOfTopArticles);

  const remainingResults = allArticles.slice(numOfTopArticles);

  const remainingResultsByTerms = {};
  remainingResults.forEach(article => {
    if (!remainingResultsByTerms[article.term]) {
      remainingResultsByTerms[article.term] = [];
    }
    remainingResultsByTerms[article.term].push(article);
  });

  return { topArticles, remainingResults: remainingResultsByTerms };
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
  const totalLinks = Object.values(results.topArticles).flat().length + Object.values(results.remainingResults).flat().length;
  const sortedResults = Object.entries(results).filter(([key]) => key !== 'topArticles' && key !== 'mostCommonTerm').sort(
    (a, b) => b[1].length - a[1].length
  );
  const mostFrequentTerm = results.mostCommonTerm;
  const subject = `Noticias Frescas ${todayDate()} - ${mostFrequentTerm}`;
  const topArticles = results.topArticles;

  let emailBody = `Estas son las ${totalLinks} noticias frescas de ${todayDate()} :<br><br>`;
  if (topArticles.length) {
    emailBody += "Noticias Relevantes:<br><br>";
    topArticles.forEach((article) => {
      emailBody += `<a href="${article.link}">${article.title}</a><br>${article.summary}<br><br>`;
    });
  } else {
    emailBody += `<b>NO encontré noticias relevantes hoy</b>`;
  }

  sortedResults.forEach(([term, articles]) => {
    if (articles.length) {
      emailBody += `<b>${term.toUpperCase()} - ${articles.length} link${articles.length === 1 ? "" : "s"}</b><br>`;
      articles.forEach((article) => {
        emailBody += `<a href="${article.link}">${article.title}</a><br>`;
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
