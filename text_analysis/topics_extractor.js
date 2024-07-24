const natural = require('natural');
const { TfIdf } = natural;
const sanitizeHtml = require('sanitize-html');

function stemWord(word, language) {
    if (language === 'ES') {
        return natural.PorterStemmerEs.stem(word);
    }
    return natural.PorterStemmer.stem(word);
}

function extractNGrams(words, n) {
    const ngrams = [];
    for (let i = 0; i <= words.length - n; i++) {
        ngrams.push(words.slice(i, i + n).join(' '));
    }
    return ngrams;
}

function calculateTopicCount(tokenCount) {
    return Math.max(5, Math.min(50, Math.floor(Math.log2(tokenCount) * 2 + 5)));
}

function getMainTopics(text, language) {
    // Sanitize and preprocess the text
    text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
    text = text.toLowerCase();
    text = text.replace(/[^\w\s]/gi, '');
    
    const words = text.split(/\s+/).filter(word => word.length > 1);
    
    // Calculate the number of topics based on the token count
    const topicCount = calculateTopicCount(words.length);
    
    // Stem words
    const stemmedWords = words.map(word => stemWord(word, language));
    
    // Extract n-grams (1-grams, 2-grams, and 3-grams)
    const unigrams = stemmedWords;
    const bigrams = extractNGrams(stemmedWords, 2);
    const trigrams = extractNGrams(stemmedWords, 3);
    
    // Combine all n-grams
    const allGrams = [...unigrams, ...bigrams, ...trigrams];
    
    // Use TF-IDF to score terms
    const tfidf = new TfIdf();
    tfidf.addDocument(allGrams);
    
    // Get top terms based on TF-IDF score
    const topTerms = [];
    tfidf.listTerms(0 /*document index*/).forEach((item) => {
        topTerms.push({ term: item.term, score: item.tfidf });
    });
    
    // Sort terms by TF-IDF score and get top N
    const sortedTerms = topTerms.sort((a, b) => b.score - a.score).slice(0, topicCount);
    
    // Return only the terms
    return sortedTerms.map(item => item.term.toLowerCase());
}

module.exports = {
    getMainTopics,
    sanitizeHtml
}