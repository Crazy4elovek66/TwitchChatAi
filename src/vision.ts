// src/vision.ts
import axios from 'axios';
import { logger } from './logger';

export interface FaceAnalysis {
    age?: string;
    emotion?: string;
    gender?: string;
    confidence: number;
}

export interface ObjectDetection {
    name: string;
    confidence: number;
    boundingBox?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

export interface ImageAnalysis {
    faces: FaceAnalysis[];
    objects: ObjectDetection[];
    text: string;
    scene?: string;
    dominantColors?: string[];
    timestamp: number;
    metadata: {
        width: number;
        height: number;
        format: string;
    };
}

export class VisionAnalyzer {
    private apiKey: string;
    private folderId: string;
    private enabled: boolean;
    private detectFaces: boolean;
    private detectObjects: boolean;
    private detectText: boolean;
    private detectScene: boolean;

    constructor() {
        this.apiKey = process.env.YANDEX_API_KEY || '';
        this.folderId = process.env.YANDEX_FOLDER_ID || '';

        this.enabled = process.env.VISION_ANALYSIS_ENABLED === '1';
        this.detectFaces = process.env.VISION_DETECT_FACES === '1';
        this.detectObjects = process.env.VISION_DETECT_OBJECTS === '1';
        this.detectText = process.env.VISION_DETECT_TEXT === '1';
        this.detectScene = process.env.VISION_DETECT_SCENE === '1';

        if (this.enabled) {
            logger.info('Vision analyzer initialized');
            logger.info(`Features: Faces=${this.detectFaces}, Objects=${this.detectObjects}, Text=${this.detectText}, Scene=${this.detectScene}`);
        }
    }

    public isEnabled(): boolean {
        return this.enabled;
    }

    public async analyzeImage(imageBuffer: Buffer): Promise<ImageAnalysis | null> {
        if (!this.enabled || !this.apiKey || !this.folderId) {
            return null;
        }

        try {
            const base64Image = imageBuffer.toString('base64');
            const promises: Promise<any>[] = [];

            // Добавляем запросы в зависимости от настроек
            if (this.detectText) {
                promises.push(this.analyzeText(base64Image));
            }

            if (this.detectFaces) {
                promises.push(this.analyzeFaces(base64Image));
            }

            if (this.detectObjects) {
                promises.push(this.analyzeObjects(base64Image));
            }

            if (this.detectScene) {
                promises.push(this.analyzeScene(base64Image));
            }

            const results = await Promise.allSettled(promises);

            const analysis: ImageAnalysis = {
                faces: [],
                objects: [],
                text: '',
                timestamp: Date.now(),
                metadata: {
                    width: 1280,
                    height: 720,
                    format: 'png'
                }
            };

            // Обрабатываем результаты
            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    this.processResult(analysis, result.value, index);
                } else {
                    logger.warn(`Vision analysis component failed:`, result.reason);
                }
            });

            return analysis;

        } catch (error) {
            logger.error('Vision analysis failed:', error);
            return null;
        }
    }

    private async analyzeText(base64Image: string): Promise<any> {
        const url = 'https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze';

        const body = {
            folderId: this.folderId,
            analyze_specs: [{
                content: base64Image,
                features: [{
                    type: 'TEXT_DETECTION',
                    text_detection_config: {
                        language_codes: ['ru', 'en']
                    }
                }]
            }]
        };

        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data;
    }

    private async analyzeFaces(base64Image: string): Promise<any> {
        const url = 'https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze';

        const body = {
            folderId: this.folderId,
            analyze_specs: [{
                content: base64Image,
                features: [{
                    type: 'FACE_DETECTION',
                    face_detection_config: {
                        // Можно настроить дополнительные параметры
                    }
                }]
            }]
        };

        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data;
    }

    private async analyzeObjects(base64Image: string): Promise<any> {
        const url = 'https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze';

        const body = {
            folderId: this.folderId,
            analyze_specs: [{
                content: base64Image,
                features: [{
                    type: 'OBJECT_DETECTION',
                    object_detection_config: {
                        // Настройки для детекции объектов
                    }
                }]
            }]
        };

        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data;
    }

    private async analyzeScene(base64Image: string): Promise<any> {
        const url = 'https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze';

        const body = {
            folderId: this.folderId,
            analyze_specs: [{
                content: base64Image,
                features: [{
                    type: 'CLASSIFICATION',
                    classification_config: {
                        model: 'quality'  // Модель для классификации сцены
                    }
                }]
            }]
        };

        const response = await axios.post(url, body, {
            headers: {
                Authorization: `Api-Key ${this.apiKey}`,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });

        return response.data;
    }

    private processResult(analysis: ImageAnalysis, result: any, index: number): void {
        if (!result?.results?.[0]?.results) {
            return;
        }

        const features = result.results[0].results;

        features.forEach((feature: any) => {
            if (feature.textDetection) {
                // Текст
                const pages = feature.textDetection.pages || [];
                const fullText = pages
                    .map((page: any) => page.blocks || [])
                    .flat()
                    .map((block: any) => block.lines || [])
                    .flat()
                    .map((line: any) => line.words || [])
                    .flat()
                    .map((word: any) => word.text || '')
                    .join(' ')
                    .trim();

                analysis.text = fullText;
            }

            if (feature.faceDetection) {
                // Лица
                const faces = feature.faceDetection.faces || [];
                faces.forEach((face: any) => {
                    const faceAnalysis: FaceAnalysis = {
                        confidence: face.confidence || 0
                    };

                    // Извлекаем атрибуты лица
                    if (face.age) {
                        faceAnalysis.age = this.mapAge(face.age);
                    }

                    if (face.emotions) {
                        faceAnalysis.emotion = this.getDominantEmotion(face.emotions);
                    }

                    if (face.gender) {
                        faceAnalysis.gender = face.gender;
                    }

                    analysis.faces.push(faceAnalysis);
                });
            }

            if (feature.objectDetection) {
                // Объекты
                const objects = feature.objectDetection.objects || [];
                objects.forEach((obj: any) => {
                    if (obj.name && obj.confidence > 0.3) { // Порог уверенности
                        analysis.objects.push({
                            name: obj.name,
                            confidence: obj.confidence,
                            boundingBox: obj.boundingBox
                        });
                    }
                });
            }

            if (feature.classification) {
                // Классификация сцены
                const properties = feature.classification.properties || [];
                if (properties.length > 0) {
                    analysis.scene = properties[0].name; // Берем наиболее вероятную сцену
                }
            }
        });
    }

    private mapAge(age: string): string {
        // Преобразуем возраст в категории
        const ageNum = parseInt(age);
        if (isNaN(ageNum)) return age;

        if (ageNum < 18) return 'подросток';
        if (ageNum < 30) return 'молодой';
        if (ageNum < 50) return 'взрослый';
        return 'пожилой';
    }

    private getDominantEmotion(emotions: Array<{ name: string, confidence: number }>): string {
        if (!emotions || emotions.length === 0) return 'нейтральный';

        // Находим эмоцию с наибольшей уверенностью
        const dominant = emotions.reduce((prev, current) =>
            (prev.confidence > current.confidence) ? prev : current
        );

        return this.translateEmotion(dominant.name);
    }

    private translateEmotion(emotion: string): string {
        const translations: Record<string, string> = {
            'neutral': 'нейтральный',
            'happiness': 'счастливый',
            'surprise': 'удивленный',
            'anger': 'злой',
            'sadness': 'грустный',
            'fear': 'испуганный',
            'disgust': 'отвращение',
            'contempt': 'презрение'
        };

        return translations[emotion.toLowerCase()] || emotion;
    }

    public formatAnalysisForPrompt(analysis: ImageAnalysis): string {
        const parts: string[] = [];

        if (analysis.faces.length > 0) {
            const facesText = analysis.faces.map(face => {
                const parts = [];
                if (face.gender) parts.push(face.gender);
                if (face.age) parts.push(face.age);
                if (face.emotion) parts.push(`выглядит ${face.emotion}`);
                return parts.join(', ');
            }).join('; ');

            parts.push(`На экране лицо(а): ${facesText}`);
        }

        if (analysis.objects.length > 0) {
            // Группируем объекты по категориям
            const objectsByCategory: Record<string, string[]> = {};

            analysis.objects.forEach(obj => {
                const category = this.categorizeObject(obj.name);
                if (!objectsByCategory[category]) {
                    objectsByCategory[category] = [];
                }
                objectsByCategory[category].push(obj.name);
            });

            Object.entries(objectsByCategory).forEach(([category, objects]) => {
                const uniqueObjects = [...new Set(objects)];
                if (uniqueObjects.length > 0) {
                    parts.push(`${category}: ${uniqueObjects.join(', ')}`);
                }
            });
        }

        if (analysis.scene) {
            parts.push(`Контекст сцены: ${analysis.scene}`);
        }

        if (analysis.text) {
            const shortText = analysis.text.length > 200
                ? analysis.text.substring(0, 200) + '...'
                : analysis.text;
            parts.push(`Текст на экране: ${shortText}`);
        }

        return parts.join('\n');
    }

    private categorizeObject(objectName: string): string {
        const categories: Record<string, string[]> = {
            'Люди': ['person', 'human', 'man', 'woman', 'child', 'baby'],
            'Техника': ['computer', 'laptop', 'monitor', 'keyboard', 'mouse', 'headphones', 'microphone', 'camera'],
            'Одежда': ['shirt', 'jacket', 'hat', 'glasses', 't-shirt'],
            'Еда/Напитки': ['bottle', 'cup', 'glass', 'food', 'drink'],
            'Игры': ['game controller', 'joystick', 'console', 'arcade'],
            'Мебель': ['chair', 'desk', 'table', 'sofa'],
            'Электроника': ['phone', 'smartphone', 'tablet', 'tv'],
            'Разное': ['book', 'paper', 'pen']
        };

        for (const [category, keywords] of Object.entries(categories)) {
            if (keywords.some(keyword => objectName.toLowerCase().includes(keyword))) {
                return category;
            }
        }

        return 'Другие объекты';
    }

    public analyzeGameplay(analysis: ImageAnalysis): string {
        // Анализ для геймплея
        const gameObjects = analysis.objects.filter(obj =>
            obj.name.toLowerCase().includes('game') ||
            obj.name.toLowerCase().includes('controller') ||
            obj.name.toLowerCase().includes('weapon') ||
            obj.name.toLowerCase().includes('character') ||
            obj.name.toLowerCase().includes('car') ||
            obj.name.toLowerCase().includes('gun')
        );

        if (gameObjects.length === 0) {
            return '';
        }

        const gameTypes = this.detectGameType(gameObjects);

        if (gameTypes.includes('shooter')) {
            return 'идет экшен-шутер';
        } else if (gameTypes.includes('racing')) {
            return 'гонки';
        } else if (gameTypes.includes('rpg')) {
            return 'ролевая игра';
        } else if (gameTypes.includes('strategy')) {
            return 'стратегия';
        } else {
            return 'игра';
        }
    }

    private detectGameType(objects: ObjectDetection[]): string[] {
        const types: string[] = [];

        const shooterKeywords = ['gun', 'rifle', 'pistol', 'weapon', 'soldier', 'combat'];
        const racingKeywords = ['car', 'vehicle', 'wheel', 'road', 'track'];
        const rpgKeywords = ['sword', 'shield', 'armor', 'dragon', 'fantasy'];
        const strategyKeywords = ['map', 'terrain', 'unit', 'base', 'resource'];

        objects.forEach(obj => {
            const name = obj.name.toLowerCase();

            if (shooterKeywords.some(keyword => name.includes(keyword))) {
                types.push('shooter');
            }
            if (racingKeywords.some(keyword => name.includes(keyword))) {
                types.push('racing');
            }
            if (rpgKeywords.some(keyword => name.includes(keyword))) {
                types.push('rpg');
            }
            if (strategyKeywords.some(keyword => name.includes(keyword))) {
                types.push('strategy');
            }
        });

        return [...new Set(types)]; // Уникальные типы
    }
}