
const lda = require('lda');
const natural = require('natural');
const sanitizeHtml = require('sanitize-html');
// Custom stopwords for English and Spanish
const {stopwordsEn, stopwordsEs} = require("./stopWords");


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

module.exports = function getMainTopics(largeText, stopwords) {
    const cleanedText = preprocess(largeText, stopwords == 'ES' ? stopwordsEs : stopwordsEn);
    const textSegments = cleanedText.match(/[^\.!\?]+[\.!\?]+/g) || [cleanedText];
    const TfIdf = natural.TfIdf;
    const tfidf = new TfIdf();
    tfidf.addDocument(cleanedText);
    let tfidfRepresentation = [];
    tfidf.documents.forEach((doc, index) => {
        let terms = [];
        for (let term in doc) {
            terms.push({ term: term, tfidf: doc[term] });
        }
        tfidfRepresentation.push(terms);
    });
    tfidfRepresentation = tfidfRepresentation[0].sort((a, b) => b.tfidf - a.tfidf);
    tfidfRepresentation = tfidfRepresentation.filter((term) => term.tfidf !== 1);
    const numberOfTopics = 1;
    const termsPerTopic = 5;
    let ldaResults = lda(textSegments, numberOfTopics, termsPerTopic);
    ldaResults = ldaResults[0].map((topic) => topic.term);
    return ldaResults.slice(0, 3);  //return top 3 terms based on probability
}
