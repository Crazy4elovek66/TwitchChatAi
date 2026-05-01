// src/local/optimizer.ts
// Оптимизация для Ryzen 7 6800H, 16GB RAM, Radeon 680M

export interface LocalConfig {
    /** Максимальное количество одновременно выполняемых процессов */
    maxConcurrentProcesses: number;
    /** Размер пакета при обработке */
    batchSize: number;
    /** Использовать квантизированные модели (меньше памяти, чуть хуже качество) */
    useQuantizedModels: boolean;
    /** Количество потоков CPU, выделяемых для обработки (рекомендуется оставить 2 ядра для системы) */
    cpuThreads: number;
    /** Ограничение памяти в МБ (рекомендуется 12000 МБ при 16 ГБ RAM) */
    memoryLimitMB: number;
    /** Использовать кэш на диске для ускорения повторных запусков */
    diskCacheEnabled: boolean;
}

export class HardwareOptimizer {
    /**
     * Возвращает оптимальную конфигурацию для текущего железа
     */
    static getOptimalConfig(): LocalConfig {
        return {
            maxConcurrentProcesses: 2,
            batchSize: 4,
            useQuantizedModels: true,
            cpuThreads: 6,          // Ryzen 7 6800H — 8 ядер/16 потоков, оставляем 2 ядра системе
            memoryLimitMB: 12000,   // Оставляем ~4 ГБ для ОС и других приложений
            diskCacheEnabled: true
        };
    }
}