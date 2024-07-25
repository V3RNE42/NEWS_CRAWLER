const natural = require('natural');
const { WordTokenizer } = natural;

function getUniqueNGrams(words, n) {
    const ngrams = new Set();
    for (let i = 0; i <= words.length - n; i++) {
        ngrams.add(words.slice(i, i + n).join(' '));
    }
    return Array.from(ngrams);
}

function scorePhrases(phrases, wordFreq) {
    return phrases.map(phrase => {
        const words = phrase.split(' ');
        const score = words.reduce((sum, word) => sum + (wordFreq[word] || 0), 0) / words.length;
        return { phrase, score };
    });
}

function calculateTopicCount(tokenCount) {
    let e = 2.71828;
    return Math.max(5, Math.min(30, Math.floor(Math.log2(tokenCount) * e)));
}

function getMainTopics(text) {
    const tokenizer = new WordTokenizer();
    const words = tokenizer.tokenize(text);

    // Calculate dynamic topic count
    const topicCount = calculateTopicCount(words.length);

    // Calculate word frequencies
    const wordFreq = {};
    words.forEach(word => {
        if (word.length > 3) {
            wordFreq[word] = (wordFreq[word] || 0) + 1;
        }
    });

    // Get unique bigrams and trigrams
    const bigrams = getUniqueNGrams(words, 2);
    const trigrams = getUniqueNGrams(words, 3);

    // Score phrases
    const scoredBigrams = scorePhrases(bigrams, wordFreq);
    const scoredTrigrams = scorePhrases(trigrams, wordFreq);

    // Combine and sort all phrases
    const allPhrases = [...scoredBigrams, ...scoredTrigrams]
        .sort((a, b) => b.score - a.score);

    // Select top phrases, ensuring no word is repeated
    const topPhrases = [];
    const usedWords = new Set();
    for (const { phrase } of allPhrases) {
        const words = phrase.split(' ');
        if (!words.some(word => usedWords.has(word))) {
            topPhrases.push(phrase);
            words.forEach(word => usedWords.add(word));
            if (topPhrases.length === topicCount) break;
        }
    }

    return topPhrases;
}

module.exports = {
    getMainTopics
};