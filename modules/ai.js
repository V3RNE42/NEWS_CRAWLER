const OpenAI = require("openai");
const config = require('../config.json');
const { countTokens } = require('./utils');
const { getProxiedContent } = require('./browser');
const { EMPTY_STRING, FAILED_SUMMARY_MSSG } = require('./constants');

const openai = new OpenAI({ apiKey: config.openai.api_key });

async function getOpenAIResponse(text, topic, maxTokens) {
    if (text == EMPTY_STRING || topic == EMPTY_STRING) {
        return EMPTY_STRING;
    }

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

const relevanceScoreAndMaxCommonFoundTerm = (title, articleContent, terms) => {
    let text = (title + ' ' + articleContent).toLowerCase();
    let termFrequencies = {};
    let termPresence = {};
    let totalWords = text.split(/\s+/).length;
    let termCount = 0;
    let presenceCount = 0;
    let coOccurrenceCount = 0;
    let mostCommonTerm = '';
    let maxCommonFoundTermCount = 0;

    terms.forEach(term => {
        termFrequencies[term] = 0;
        termPresence[term] = 0;
    });

    terms.forEach(term => {
        let regex = new RegExp("\\b" + term + "\\b", 'ig');
        let matches = text.match(regex) || [];
        let termCountLocal = matches.length;
        termFrequencies[term] = termCountLocal;
        termPresence[term] = termCountLocal > 0 ? 1 : 0;
        presenceCount += termPresence[term];
        termCount += termCountLocal;

        if (termCountLocal > maxCommonFoundTermCount) {
            mostCommonTerm = term;
            maxCommonFoundTermCount = termCountLocal;
        }
    });

    const hasMinimumFrequency = Object.values(termFrequencies).some(count => count >= 3);

    if (!hasMinimumFrequency) {
        return { score: 0, mostCommonTerm: '' };
    }

    let termDensity = termCount / totalWords;

    terms.forEach((term, index) => {
        for (let i = index + 1; i < terms.length; i++) {
            let otherTerm = terms[i];
            let coOccurrences = 0;
            let termRegex = new RegExp(`\\b${term}\\b`, 'gi');
            let otherTermRegex = new RegExp(`\\b${otherTerm}\\b`, 'gi');
            let termMatch, otherTermMatch;

            while ((termMatch = termRegex.exec(text)) !== null) {
                while ((otherTermMatch = otherTermRegex.exec(text)) !== null) {
                    if (Math.abs(termMatch.index - otherTermMatch.index) <= 10) {
                        coOccurrences++;
                    }
                }
            }
            coOccurrenceCount += coOccurrences;
        }
    });

    let termFrequencySum = Object.values(termFrequencies).reduce((a, b) => a + b, 0);
    let termPresenceSum = presenceCount;
    let coOccurrenceSum = coOccurrenceCount;

    let weights = {
        frequency: 0.1,
        presence: 0.2,
        density: 0.3,
        coOccurrence: 0.4
    };

    let globalRelevanceScore =
        (weights.frequency * termFrequencySum) +
        (weights.presence * termPresenceSum) +
        (weights.density * termDensity) +
        (weights.coOccurrence * coOccurrenceSum);

    globalRelevanceScore = parseFloat(globalRelevanceScore.toFixed(4));

    return { score: globalRelevanceScore, mostCommonTerm };
}

module.exports = {
    getOpenAIResponse,
    summarizeText,
    relevanceScoreAndMaxCommonFoundTerm
};
