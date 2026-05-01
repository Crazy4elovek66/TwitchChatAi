import { exec } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as https from 'https';

async function downloadFile(url: string, dest: string): Promise<void> {
    const file = await fs.open(dest, 'w');
    return new Promise((resolve, reject) => {
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
                return;
            }
            response.pipe(file.createWriteStream());
            response.on('end', () => {
                file.close();
                resolve();
            });
        }).on('error', reject);
    });
}

async function unzip(file: string, destDir: string): Promise<void> {
    await new Promise((resolve, reject) => {
        exec(`unzip -o "${file}" -d "${destDir}"`, (error) => {
            if (error) reject(error);
            else resolve(0);
        });
    });
}

async function main() {
    const modelsDir = path.join(process.cwd(), 'models');
    await fs.mkdir(modelsDir, { recursive: true });

    const modelName = 'vosk-model-small-ru-0.22';
    const modelUrl = 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip';
    const modelPath = path.join(modelsDir, modelName);

    try {
        await fs.access(modelPath);
        console.log(`✅ Модель ${modelName} уже существует в ${modelPath}`);
    } catch {
        console.log(`⬇️ Скачиваем ${modelName}...`);
        const zipPath = path.join(modelsDir, `${modelName}.zip`);
        await downloadFile(modelUrl, zipPath);
        console.log(`📦 Распаковываем...`);
        await unzip(zipPath, modelsDir);
        await fs.unlink(zipPath);
        console.log(`✅ Модель ${modelName} установлена.`);
    }

    console.log('✅ Все модели готовы.');
    console.log('Модель LaMini-Flan-T5-783M скачается автоматически при первом запуске.');
}

main().catch(console.error);