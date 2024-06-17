const lda = require('lda');
const natural = require('natural');
const sanitizeHtml = require('sanitize-html');
// Custom stopwords for English and Spanish
const { stopwordsEn, stopwordsEs } = require("./stopWords");

function filterWords(words, stopwords) {
    const result = [];

    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (!stopwords.includes(word) && word.length > 2) {
            result.push(word);
        }
    }

    return result;
}

function preprocess(text, stopwords) {
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
    text = text.toLowerCase();
    text = text.replace(/[^\w\s]/gi, '');

    const words = text.split(/\s+/);
    const filteredWords = filterWords(words, stopwords);

    return filteredWords.join(' ');
}

function getMainTopics(largeText, stopwords) {
    const cleanText = preprocess(largeText, stopwords == 'ES' ? stopwordsEs : stopwordsEn);
    const textSegments = cleanText.match(/[^\.!\?]+[\.!\?]+/g) || [cleanText];
    const TfIdf = natural.TfIdf;
    const tfidf = new TfIdf();

    tfidf.addDocument(cleanText);
    let tfidfRepresentation = [];
    tfidf.documents.forEach((doc, index) => {
        let terms = Object.keys(doc).map((term) => ({ term, tfidf: doc[term] }));
        tfidfRepresentation.push(terms);
    });

    tfidfRepresentation = tfidfRepresentation[0].sort((a, b) => b.tfidf - a.tfidf);
    tfidfRepresentation = tfidfRepresentation.filter((term) => term.tfidf !== 1).map((term) => term.term);

    const numberOfTopics = 1;
    const termsPerTopic = Math.floor(Math.log10(cleanText.length)) + 1; //some sensibility towards elgnth of text vs topics covered

    let ldaResults = lda(textSegments, numberOfTopics, termsPerTopic);
    ldaResults = ldaResults[0].map((topic) => topic.term).slice(0, Math.ceil(termsPerTopic / 2));
    let retorno = [];
    ldaResults.forEach(result => retorno.push(result.term));

    return retorno;
}

module.exports = {
    getMainTopics
};
