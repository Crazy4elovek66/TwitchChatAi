// src/messageFilter.ts
export class MessageFilter {
    private static forbiddenPatterns = [
        /что.*дальше/gi,
        /интересно.*(что|как)/gi,
        /расскажи.*подробнее/gi,
        /^лол[.,!]*$/gi,
        /повтори.*пожалуйста/gi,
        /можно.*вопрос/gi,
        /объясни.*пожалуйста/gi,
        /что.*происходит/gi,
        /что.*случилось/gi,
        /чего.*такое/gi,
        /че.*там.*(происходит|случилось)/gi,
        /а.*че.*это.*было/gi
    ];

    private static commonBotPhrases = [
        'лол',
        'интересно',
        'что дальше',
        'расскажи',
        'объясни',
        'можно вопрос',
        'что происходит',
        'что случилось',
        'че там',
        'а че это было',
        'ого интересно',
        'вау интересно'
    ];

    static filterMessage(message: string): string {
        let filtered = message;

        this.forbiddenPatterns.forEach(pattern => {
            filtered = filtered.replace(pattern, '');
        });

        filtered = filtered.replace(/\s+/g, ' ').trim();

        if (filtered.length < 3) {
            return '';
        }

        const lowerMessage = filtered.toLowerCase();
        const isCommonPhrase = this.commonBotPhrases.some(phrase =>
            lowerMessage.includes(phrase.toLowerCase())
        );

        if (isCommonPhrase && filtered.split(' ').length <= 3) {
            return '';
        }

        return filtered;
    }

    static isTooSimilar(existingMessages: string[], newMessage: string): boolean {
        const cleanNew = newMessage.toLowerCase().replace(/[^\w\sа-я]/gi, '');

        for (const existing of existingMessages) {
            const cleanExisting = existing.toLowerCase().replace(/[^\w\sа-я]/gi, '');

            if (cleanNew === cleanExisting) return true;

            if (cleanNew.includes(cleanExisting) || cleanExisting.includes(cleanNew)) {
                return true;
            }

            const wordsNew = new Set(cleanNew.split(/\s+/));
            const wordsExisting = new Set(cleanExisting.split(/\s+/));
            const intersection = [...wordsNew].filter(x => wordsExisting.has(x));

            if (intersection.length >= 2 && intersection.length / wordsNew.size > 0.5) {
                return true;
            }
        }

        return false;
    }
}