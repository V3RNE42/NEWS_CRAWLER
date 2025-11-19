const { parse: parseUrl, format } = require('url');
const { differenceInHours, parseISO, isValid, subMinutes, parse } = require('date-fns');
const { enUS, es } = require('date-fns/locale');

const MINUTES_TO_CLOSE = 15 * 60000;

class LightweightError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LightweightError';
        Error.captureStackTrace = null;
    }
}

const removePatterns = (content, ArrRegExpToRemove) => {
    let newContent = content;
    let changed = false;

    for (let pat of ArrRegExpToRemove) {
        const tempContent = newContent.replace(pat, '');
        if (tempContent !== newContent) {
            newContent = tempContent;
            changed = true;
        }
    }

    if (changed) {
        return removePatterns(newContent, ArrRegExpToRemove);
    }

    return newContent;
};

const parseTime = (timeStr) => {
    const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;

    if (!timeRegex.test(timeStr)) {
        throw new LightweightError('Invalid time format. Please use HH:MM (24-hour format).');
    }

    const [hourStr, minuteStr] = timeStr.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    if (isNaN(hour) || isNaN(minute)) {
        throw new LightweightError('Invalid time: hour or minute is not a number');
    }

    const now = new Date();
    const result = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);

    result.setMinutes(result.getMinutes() - Math.floor(MINUTES_TO_CLOSE / 60000));

    if (result <= now) {
        result.setDate(result.getDate() + 1);
    }

    return result;
};

const todayDate = () => {
    const today = new Date();
    const day = String(today.getDate()).padStart(2, '0');
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const year = today.getFullYear();
    return `${day}/${month}/${year}`;
}

const sleep = async (ms) => new Promise(resolve => setTimeout(resolve, ms));

const countTokens = (text) => {
    if (!text) return 0;
    return text.trim().split(/\s+/).length;
}

function isRecent(dateText) {
    if (!dateText) return false;
    const now = new Date();
    let date;

    if (/^\d+$/.test(dateText)) {
        const timestamp = parseInt(dateText, 10);
        if (timestamp > 0) {
            date = new Date(timestamp * 1000);
            return differenceInHours(now, date) < 24 || date > now;
        }
    }

    date = parseISO(dateText);
    if (isValid(date)) {
        return differenceInHours(now, date) < 24 || date > now;
    }

    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

    const rfc822Match_1 = dateText.match(/(\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4})/);
    if (rfc822Match_1) {
        const [_, day, month, year, time, offset] = rfc822Match_1;
        date = new Date(`${year}-${(months[month] + 1).toString().padStart(2, '0')}-${day.padStart(2, '0')}T${time}${offset}`);
        return differenceInHours(now, date) < 24 || date > now;
    }

    const rfc2822Match_2 = dateText.match(/[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}:\d{2}:\d{2}) ([+-]\d{4}|GMT)/);
    if (rfc2822Match_2) {
        const [_, day, monthStr, year, time, offset] = rfc2822Match_2;
        const month = months[monthStr];
        const combinedDate = `${year}-${month + 1}-${day}T${time}`;
        date = new Date(combinedDate);

        if (offset !== 'GMT') {
            const offsetHours = parseInt(offset.slice(0, 3));
            const offsetMinutes = parseInt(offset.slice(3));
            const totalOffsetMinutes = offsetHours * 60 + (offsetHours < 0 ? -offsetMinutes : offsetMinutes);
            date = subMinutes(date, totalOffsetMinutes);
        }
        return differenceInHours(now, date) < 24 || date > now;
    }

    const offsetMap = {
        'ACDT': 10.5, 'ACST': 9.5, 'ACT': -5, 'ACWST': 8.75, 'ADT': -3, 'AEDT': 11,
        'AEST': 10, 'AET': 10, 'AFT': 4.5, 'AKDT': -8, 'AKST': -9, 'ALMT': 6,
        'AMST': -3, 'AMT': -4, 'ANAT': 12, 'AQTT': 5, 'ART': -3, 'AST': -4,
        'AWST': 8, 'AZOST': 0, 'AZOT': -1, 'AZT': 4, 'BDT': 8, 'BIOT': 6,
        'BIT': -12, 'BOT': -4, 'BRST': -2, 'BRT': -3, 'BST': 1, 'BTT': 6,
        'CAT': 2, 'CCT': 6.5, 'CDT': -5, 'CEST': 2, 'CET': 1, 'CHADT': 13.75,
        'CHAST': 12.75, 'CHOT': 8, 'CHOST': 9, 'CHST': 10, 'CHUT': 10, 'CIST': -8,
        'CIT': 8, 'CKT': -10, 'CLST': -3, 'CLT': -4, 'COST': -4, 'COT': -5,
        'CST': -6, 'CT': 8, 'CVT': -1, 'CWST': 8.75, 'CXT': 7, 'DAVT': 7,
        'DDUT': 10, 'DFT': 1, 'EASST': -5, 'EAST': -6, 'EAT': 3, 'ECT': -5,
        'EDT': -4, 'EEST': 3, 'EET': 2, 'EGST': 0, 'EGT': -1, 'EST': -5,
        'ET': -5, 'FET': 3, 'FJT': 12, 'FKST': -3, 'FKT': -4, 'FNT': -2,
        'GALT': -6, 'GAMT': -9, 'GET': 4, 'GFT': -3, 'GILT': 12, 'GMT': 0,
        'GST': 4, 'GYT': -4, 'HDT': -9, 'HAEC': 2, 'HST': -10, 'HKT': 8,
        'HMT': 5, 'HOVT': 7, 'ICT': 7, 'IDLW': -12, 'IDT': 3, 'IOT': 6,
        'IRDT': 4.5, 'IRKT': 8, 'IRST': 3.5, 'IST': 5.5, 'JST': 9, 'KALT': 2,
        'KGT': 6, 'KOST': 11, 'KRAT': 7, 'KST': 9, 'LHST': 10.5, 'LINT': 14,
        'MAGT': 12, 'MART': -9.5, 'MAWT': 5, 'MDT': -6, 'MET': 1, 'MEST': 2,
        'MHT': 12, 'MIST': 11, 'MIT': -9.5, 'MMT': 6.5, 'MSK': 3, 'MST': -7,
        'MUT': 4, 'MVT': 5, 'MYT': 8, 'NCT': 11, 'NDT': -2.5, 'NFT': 11,
        'NOVT': 7, 'NPT': 5.75, 'NST': -3.5, 'NT': -3.5, 'NUT': -11, 'NZDT': 13,
        'NZST': 12, 'OMST': 6, 'ORAT': 5, 'PDT': -7, 'PET': -5, 'PETT': 12,
        'PGT': 10, 'PHOT': 13, 'PHT': 8, 'PKT': 5, 'PMDT': -2, 'PMST': -3,
        'PONT': 11, 'PST': -8, 'PWT': 9, 'PYST': -3, 'PYT': -4, 'RET': 4,
        'ROTT': -3, 'SAKT': 11, 'SAMT': 4, 'SAST': 2, 'SBT': 11, 'SCT': 4,
        'SDT': -10, 'SGT': 8, 'SLST': 5.5, 'SRET': 11, 'SRT': -3, 'SST': 8,
        'SYOT': 3, 'TAHT': -10, 'THA': 7, 'TFT': 5, 'TJT': 5, 'TKT': 13,
        'TLT': 9, 'TMT': 5, 'TRT': 3, 'TOT': 13, 'TVT': 12, 'ULAST': 9,
        'ULAT': 8, 'USZ1': 2, 'UTC': 0, 'UYST': -2, 'UYT': -3, 'UZT': 5,
        'VET': -4, 'VLAT': 10, 'VOLT': 4, 'VOST': 6, 'VUT': 11, 'WAKT': 12,
        'WAST': 2, 'WAT': 1, 'WEST': 1, 'WET': 0, 'WIT': 7, 'WGST': -2,
        'WGT': -3, 'WST': 8, 'YAKT': 9, 'YEKT': 5
    };

    let tzOffsetMatch = dateText.match(/(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})/);
    if (tzOffsetMatch) {
        let [_, datePart, offset] = tzOffsetMatch;
        date = parse(datePart, 'dd/MM/yyyy HH:mm:ss', new Date());
        if (isValid(date)) {
            let [hoursOffset, minutesOffset] = offset.split(':').map(Number);
            let totalOffsetMinutes = hoursOffset * 60 + (hoursOffset < 0 ? -minutesOffset : minutesOffset);
            date = subMinutes(date, totalOffsetMinutes);
            return differenceInHours(now, date) < 24 || date > now;
        }
    }

    let cosa = dateText.match(/(\d{2}\/\d{2}\/\d{4} \d{1}:\d{2}:\d{2}) ([+-]\d{2}:\d{2})/);
    if (cosa) {
        let [_, datePart, offset] = cosa;
        date = parse(datePart, 'dd/MM/yyyy H:mm:ss', new Date());
        if (isValid(date)) {
            let [hoursOffset, minutesOffset] = offset.split(':').map(Number);
            let totalOffsetMinutes = hoursOffset * 60 + (hoursOffset < 0 ? -minutesOffset : minutesOffset);
            date = subMinutes(date, totalOffsetMinutes);
            return differenceInHours(now, date) < 24 || date > now;
        }
    }

    let tzAbbrMatch = dateText.match(/(\d{4}-\d{2}-\d{2})([A-Z]{3,5})(\d{2}:\d{2}:\d{2})/);
    if (tzAbbrMatch) {
        let [_, datePart, tz, timePart] = tzAbbrMatch;
        let combinedDate = `${datePart}T${timePart}`;

        let offset = offsetMap[tz];
        if (offset !== undefined) {
            date = parse(combinedDate, "yyyy-MM-dd'T'HH:mm:ss", new Date());
            if (isValid(date)) {
                let totalOffsetMinutes = offset * 60;
                date = subMinutes(date, totalOffsetMinutes);
                return differenceInHours(now, date) < 24 || date > now;
            }
        }
    }

    let tzMatch = dateText.match(/(\d{4}-\d{2}-\d{2})([A-Z]{3,5})(\d{2}:\d{2})/);
    if (tzMatch) {
        let [_, datePart, tz, timePart] = tzMatch;
        let combinedDate = `${datePart}T${timePart}`;

        let offset = offsetMap[tz];
        if (offset !== undefined) {
            date = parse(combinedDate, "yyyy-MM-dd'T'HH:mm", new Date());
            if (isValid(date)) {
                let totalOffsetMinutes = offset * 60;
                date = subMinutes(date, totalOffsetMinutes);
                return differenceInHours(now, date) < 24 || date > now;
            }
        }
    }

    date = parse(dateText, 'dd/MM/yyyy HH:mm', new Date());
    if (isValid(date)) {
        return differenceInHours(now, date) < 24 || date > now;
    }

    date = parse(dateText, 'dd-MM-yyyy HH:mm:ss', new Date());
    if (isValid(date)) {
        return differenceInHours(now, date) < 24 || date > now;
    }

    let preambleMatch = dateText.match(/.*, (\w+ \d{2}, \d{4})/);
    if (preambleMatch) {
        let [_, datePart] = preambleMatch;
        date = parse(datePart, 'MMMM dd, yyyy', new Date(), { locale: enUS });
        if (isValid(date)) {
            return differenceInHours(now, date) < 24 || date > now;
        }
    }

    let relativeMatchES = dateText.match(/hace (\d+) (minutos?|horas?|días?|semanas?|meses?)/i);
    let relativeMatchEN = dateText.match(/(\d+) (minute|hour|day|week|month)s? ago/i);
    if (relativeMatchES || relativeMatchEN) {
        let [_, amount, unit] = relativeMatchES || relativeMatchEN;
        date = new Date(now);
        switch (unit.toLowerCase()) {
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
        return differenceInHours(now, date) < 24;
    }

    let formats = [
        'dd/MM/yyyy',
        'MM/dd/yyyy',
        'dd-MM-yyyy',
        'yyyy-MM-dd',
        'd MMMM yyyy',
        'MMMM d, yyyy',
        'd MMM yyyy',
        'MMM d, yyyy',
        "d 'de' MMMM 'de' yyyy",
        "d 'de' MMM'.' 'de' yyyy",
        'yyyy-MM-dd HH:mm:ss',
        "EEEE d 'de' MMMM"
    ];

    for (let format of formats) {
        date = parse(dateText, format, new Date(), { locale: es });
        if (isValid(date)) break;
        date = parse(dateText, format, new Date(), { locale: enUS });
        if (isValid(date)) break;
    }

    if (isValid(date)) {
        return differenceInHours(now, date) < 24 || date > now;
    }

    let spanishMonthAbbr = {
        'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'may': 4, 'jun': 5,
        'jul': 6, 'ago': 7, 'sept': 8, 'sep': 8, 'oct': 9, 'nov': 10, 'dic': 11
    };
    let match = dateText.match(/(\d{1,2})?\s*(?:de)?\s*(\w+)\.?\s*(?:de)?\s*(\d{4})?/i);
    if (match) {
        let [_, day, month, year] = match;
        month = spanishMonthAbbr[month.toLowerCase().substring(0, 3)];
        if (month !== undefined) {
            year = year ? parseInt(year) : now.getFullYear();
            day = day ? parseInt(day) : 1;
            date = new Date(year, month, day);
            return differenceInHours(now, date) < 24 || date > now;
        }
    }

    let nlMatch = dateText.match(/(\d{1,2})\s*de\s*(\w+)\s*del?\s*(\d{4})/i);
    if (nlMatch) {
        let [_, day, month, year] = nlMatch;
        let spanishMonthFull = {
            'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
            'julio': 6, 'agosto': 7, 'septiembre': 8, 'octubre': 9, 'noviembre': 10, 'diciembre': 11
        };
        month = spanishMonthFull[month.toLowerCase()];
        if (month !== undefined) {
            date = new Date(parseInt(year), month, parseInt(day));
            return differenceInHours(now, date) < 24 || date > now;
        }
    }

    date = new Date(dateText);
    if (isValid(date)) {
        return differenceInHours(now, date) < 24 || date > now;
    }

    console.warn(`Could not parse date: ${dateText}`);
    return false;
}

const weirdCharacters = ['?', '%', '#'];

function removeWeirdCharactersFromUrl(url) {
    for (let char of weirdCharacters) {
        if (url.includes(char)) {
            const index = url.indexOf(char);
            url = url.substring(0, index);
        }
    }
    return url;
}

function normalizeUrl(url) {
    const parsedUrl = parseUrl(url);
    parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '');
    return format(parsedUrl);
}

function denormalizeUrl (url) {
    return normalizeUrl(url)+"/";
}

const isURLValid = (url) => {
    try {
        new URL(url);
        if (url.includes('http')) {
            return true;
        } else  {
            return false;
        }
    } catch (_) {
        return false;
    }
}

function getDomain(url) {
    const parsedUrl = parseUrl(url);
    return parsedUrl.hostname;
}

function closeToEmailingTime(emailEndTime) {
    if (!(emailEndTime instanceof Date) || isNaN(emailEndTime.getTime())) {
        console.error('Invalid emailEndTime provided to closeToEmailingTime');
        return false;
    }

    const now = new Date();
    const endWindow = new Date(emailEndTime.getTime() + (MINUTES_TO_CLOSE * 3));

    if (now >= emailEndTime && now < endWindow) {
        return true;
    }

    return false;
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const temp = array[i];
        array[i] = array[j];
        array[j] = temp;
    }
    return array;
}

function calculatePercentile(values, percentile) {
    if (values.length === 0) return 0;
    values.sort((a, b) => a - b);
    const index = Math.floor(percentile * values.length);
    return values[index];
}

const splitArrayIntoChunks = (array, numChunks) => {
    let set = new Set(array);
    array = Array.from(set);
    
    if (numChunks <= 0) return [];
    if (numChunks >= array.length) return array.map(item => [item]);

    const chunks = Array.from({ length: numChunks }, () => []);
    const chunkSize = Math.floor(array.length / numChunks);
    const remainder = array.length % numChunks;
    
    let index = 0;
    for (let i = 0; i < numChunks; i++) {
        let size = chunkSize + (i < remainder ? 1 : 0);
        chunks[i] = array.slice(index, index + size);
        index += size;
    }
    
    return chunks;
};

const urlContainsOpinion = (url) => {
    return url ? url.toLowerCase().includes('#comment') || url.toLowerCase().includes('/opinion/') : false;
}

function isWebsiteValid(baseUrl, fullLink) {

    if (urlContainsOpinion(fullLink)) return false;

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

module.exports = {
    LightweightError,
    removePatterns,
    parseTime,
    todayDate,
    sleep,
    countTokens,
    isRecent,
    removeWeirdCharactersFromUrl,
    normalizeUrl,
    denormalizeUrl,
    isURLValid,
    getDomain,
    closeToEmailingTime,
    shuffleArray,
    calculatePercentile,
    splitArrayIntoChunks,
    urlContainsOpinion,
    isWebsiteValid,
    MINUTES_TO_CLOSE
};
