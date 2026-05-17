// =====================================================
// server.js
// Electron 最终稳定版
// M3U8 检测 + 分辨率检测 + TS精确检测 + 重试
// =====================================================

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');

process.on('uncaughtException', err => {
    console.error('未捕获异常:', err);
});

process.on('unhandledRejection', err => {
    console.error('Promise异常:', err);
});

const app = express();

const PORT = 3000;

app.use(express.json({
    limit: '100mb'
}));

app.use(express.urlencoded({
    extended: true,
    limit: '100mb'
}));

// =====================================================
// Electron / 开发环境兼容
// =====================================================

const isElectron = !!process.versions.electron;

const publicPath = isElectron
    ? path.join(process.resourcesPath, 'public')
    : path.join(__dirname, 'public');

app.use(express.static(publicPath));

// =====================================================
// FFmpeg 路径
// =====================================================

const ffmpegExe = isElectron
    ? path.join(process.resourcesPath, 'ffmpeg.exe')
    : path.join(__dirname, 'ffmpeg.exe');

const ffprobeExe = isElectron
    ? path.join(process.resourcesPath, 'ffprobe.exe')
    : path.join(__dirname, 'ffprobe.exe');

console.log('FFmpeg路径:', ffmpegExe);
console.log('FFprobe路径:', ffprobeExe);

ffmpeg.setFfmpegPath(ffmpegExe);
ffmpeg.setFfprobePath(ffprobeExe);

// =====================================================
// 上传
// =====================================================

const upload = multer({
    dest: 'uploads/'
});

// =====================================================
// 全局控制
// =====================================================

let isPaused = false;
let isStopped = false;

// =====================================================
// 工具
// =====================================================

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function waitIfPaused() {

    while (isPaused && !isStopped) {
        await sleep(300);
    }
}

// =====================================================
// 检测 M3U8 是否有效
// =====================================================

async function checkM3U8(url, timeout = 8000) {

    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, timeout);

    try {

        const res = await fetch(url, {
            signal: controller.signal
        });

        if (!res.ok) {

            return {
                valid: false,
                msg: `HTTP ${res.status}`
            };
        }

        const text = await res.text();

        if (
            text.includes('#EXTM3U') ||
            text.includes('#EXTINF')
        ) {

            return {
                valid: true,
                msg: '有效'
            };
        }

        return {
            valid: false,
            msg: '非M3U8'
        };

    } catch (e) {

        return {
            valid: false,
            msg: e.message
        };

    } finally {

        clearTimeout(timer);

    }
}

// =====================================================
// 主播放列表分辨率检测
// =====================================================

async function getM3U8Resolution(url) {

    try {

        const res = await fetch(url);

        const text = await res.text();

        const regex = /RESOLUTION=(\d+x\d+)/g;

        const list = [];

        let m;

        while ((m = regex.exec(text)) !== null) {

            list.push(m[1]);

        }

        if (list.length > 0) {

            return [...new Set(list)];

        }

        // 单分辨率媒体列表

        if (text.includes('#EXTINF')) {

            return ['单分辨率'];

        }

        return ['未知'];

    } catch {

        return ['未知'];

    }
}

// =====================================================
// TS真实分辨率检测
// =====================================================

async function getTSResolution(tsUrl, retries = 2) {

    for (let i = 0; i <= retries; i++) {

        try {

            console.log(`TS检测 ${i + 1}: ${tsUrl}`);

            const result = await new Promise(resolve => {

                ffmpeg(tsUrl).ffprobe((err, metadata) => {

                    if (err) {

                        console.log('ffprobe失败:', err.message);

                        return resolve('未知');
                    }

                    const stream = metadata.streams.find(
                        s => s.codec_type === 'video'
                    );

                    if (!stream) {

                        return resolve('未知');

                    }

                    resolve(
                        `${stream.width}x${stream.height}`
                    );

                });

            });

            if (result !== '未知') {

                console.log('TS分辨率:', result);

                return result;

            }

        } catch (e) {

            console.log('TS异常:', e.message);

        }

        await sleep(500);
    }

    return '未知';
}

// =====================================================
// 并发批量检测
// =====================================================

async function checkBatch(
    items,
    concurrency,
    timeout,
    enableTSResolution,
    onProgress
) {

    let index = 0;

    const results = new Array(items.length);

    let validCount = 0;
    let invalidCount = 0;

    async function worker() {

        while (index < items.length) {

            if (isStopped) break;

            await waitIfPaused();

            const current = index++;

            const item = items[current];

            console.log(
                `[${current + 1}/${items.length}] 开始检测`
            );

            const checkResult = await checkM3U8(
                item.url,
                timeout
            );

            let resolutions = ['未知'];

            if (checkResult.valid) {

                resolutions = await getM3U8Resolution(
                    item.url
                );

                // =================================================
                // 单分辨率精确检测
                // =================================================

                if (
                    enableTSResolution &&
                    resolutions.length === 1 &&
                    resolutions[0] === '单分辨率'
                ) {

                    try {

                        const text = await fetch(
                            item.url
                        ).then(r => r.text());

                        const tsLine = text
                            .split(/\r?\n/)
                            .find(
                                l =>
                                    l &&
                                    !l.startsWith('#')
                            );

                        if (tsLine) {

                            const tsUrl = new URL(
                                tsLine,
                                item.url
                            ).href;

                            const realRes =
                                await getTSResolution(tsUrl);

                            resolutions = [realRes];
                        }

                    } catch (e) {

                        console.log(
                            'TS解析失败:',
                            e.message
                        );

                    }
                }

                validCount++;

            } else {

                invalidCount++;

            }

            results[current] = {
                index: current + 1,
                name: item.name,
                url: item.url,
                valid: checkResult.valid,
                msg: checkResult.msg,
                resolutions
            };

            console.log(
                `[${current + 1}/${items.length}]`,
                checkResult.valid ? '有效' : '无效',
                resolutions.join(',')
            );

            if (onProgress) {

                onProgress({
                    current: current + 1,
                    total: items.length,
                    valid: validCount,
                    invalid: invalidCount,
                    result: results[current]
                });

            }
        }
    }

    const workers = [];

    for (
        let i = 0;
        i < Math.min(concurrency, items.length);
        i++
    ) {

        workers.push(worker());

    }

    await Promise.all(workers);

    return results;
}

// =====================================================
// 检测接口
// =====================================================

app.post('/check', async (req, res) => {

    try {

        isStopped = false;

        const {
            links,
            concurrency = 5,
            timeout = 8000,
            enableTSResolution = false
        } = req.body;

        if (!links || !links.length) {

            return res.json({
                error: '没有链接'
            });

        }

        const items = links.map((line, i) => {

            if (line.includes(',')) {

                const idx = line.indexOf(',');

                return {
                    name: line.slice(0, idx).trim(),
                    url: line.slice(idx + 1).trim()
                };
            }

            return {
                name: `${i + 1}`,
                url: line.trim()
            };
        });

        const results = await checkBatch(
            items,
            Number(concurrency),
            Number(timeout),
            enableTSResolution
        );

        res.json({
            success: true,
            results
        });

    } catch (e) {

        console.error(e);

        res.json({
            success: false,
            error: e.message
        });

    }
});

// =====================================================
// 上传 TXT/M3U
// =====================================================

app.post(
    '/upload',
    upload.single('file'),
    async (req, res) => {

        try {

            if (!req.file) {

                return res.json({
                    success: false,
                    error: '未上传文件'
                });

            }

            const text = fs.readFileSync(
                req.file.path,
                'utf-8'
            );

            fs.unlinkSync(req.file.path);

            const lines = text
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean);

            res.json({
                success: true,
                lines
            });

        } catch (e) {

            console.error(e);

            res.json({
                success: false,
                error: e.message
            });

        }
    }
);

// =====================================================
// 暂停
// =====================================================

app.post('/pause', (req, res) => {

    isPaused = true;

    console.log('检测已暂停');

    res.json({
        success: true
    });

});

// =====================================================
// 继续
// =====================================================

app.post('/resume', (req, res) => {

    isPaused = false;

    console.log('检测继续');

    res.json({
        success: true
    });

});

// =====================================================
// 停止
// =====================================================

app.post('/stop', (req, res) => {

    isStopped = true;

    console.log('检测已停止');

    res.json({
        success: true
    });

});

// =====================================================
// 启动
// =====================================================

app.listen(PORT, () => {

    console.log('');
    console.log('====================================');
    console.log('M3U8检测器启动成功');
    console.log(`http://localhost:${PORT}`);
    console.log('====================================');
    console.log('');

});
