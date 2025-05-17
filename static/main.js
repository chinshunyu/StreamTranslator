// 导入录音器类
import PCMAudioRecorder from '/static/audio_recorder.js';



// 获取DOM元素
const startButton = document.getElementById('startButton');
const stopButton = document.getElementById('stopButton');
const recognitionText = document.getElementById('recognitionText');
const translationText = document.getElementById('translationText');
const statusIndicator = document.querySelector('.status-indicator');
const statusText = document.querySelector('.status-text');
const recognitionCaptions = document.getElementById('recognitionCaptions');
const translationCaptions = document.getElementById('translationCaptions');

// WebSocket 服务器地址 - 动态生成以适应当前环境
// 使用当前网页的主机名和端口，并将协议从 http/https 改为 ws/wss
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const host = window.location.host; // 包含主机名和端口
const wsServerUrl = `${protocol}//${host}/ws`;
console.log('使用 WebSocket 地址:', wsServerUrl);
let socket = null;
let recorder = null;
let isRecording = false;

// 初始化录音器
function initRecorder() {
    recorder = new PCMAudioRecorder();
    console.log('录音器初始化完成');
}

// WebSocket 重连参数
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_INTERVAL = 2000; // 2秒
let reconnectAttempts = 0;
let reconnectTimer = null;

// 连接 WebSocket 服务器
function connectWebSocket() {
    // 如果已经有重连计时器，先清除
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    
    if (socket && socket.readyState === WebSocket.OPEN) {
        console.log('已经连接到 WebSocket 服务器');
        return;
    }
    
    // 如果正在连接中，则不再创建新连接
    if (socket && socket.readyState === WebSocket.CONNECTING) {
        console.log('WebSocket 正在连接中...');
        return;
    }
    
    // 如果有旧连接，先关闭
    if (socket) {
        try {
            socket.close();
        } catch (e) {
            console.error('关闭旧连接出错:', e);
        }
    }
    
    updateStatus('connecting', '正在连接...');
    socket = new WebSocket(wsServerUrl);
    
    socket.onopen = () => {
        console.log('WebSocket 连接已建立');
        updateStatus('connected', '已连接');
        // 重置重连计数
        reconnectAttempts = 0;
    };
    
    socket.onmessage = (event) => {
        try {
            console.log('收到原始消息:', event.data);
            const message = JSON.parse(event.data);
            console.log('解析后的消息:', message);
            
            if (message.type === 'results') {
                // 处理中间结果
                console.log('收到结果数据:', JSON.stringify(message.data, null, 2));
                console.log('结果数据类型:', typeof message.data);
                console.log('识别结果:', message.data.recognition);
                // console.log("=======")
                // console.log(message.data);
                // console.log("=======")
                console.log('翻译结果:', message.data.translation);
                
                // 直接更新DOM元素
                document.getElementById('recognitionText').textContent = message.data.recognition || '';
                document.getElementById('translationText').textContent = message.data.translation || '';
                
                // 仍然调用原来的函数进行字幕处理
                updateRecognitionAndTranslation(message.data);
            } else if (message.type === 'final_results') {
                // 处理最终结果
                console.log('收到最终结果:', JSON.stringify(message.data, null, 2));
                console.log('结果数据类型:', typeof message.data);
                console.log('识别结果:', message.data.recognition);
                console.log('翻译结果:', message.data.translation);
                
                // 直接更新DOM元素
                document.getElementById('recognitionText').textContent = message.data.recognition || '';
                document.getElementById('translationText').textContent = message.data.translation || '';
                
                // 仍然调用原来的函数进行字幕处理
                updateRecognitionAndTranslation(message.data);
                updateStatus('connected', '已连接');
            } else if (message.type === 'error') {
                console.error('服务器错误:', message.message);
                showError('服务器错误: ' + message.message);
            } else if (message.type === 'connection') {
                console.log('连接状态更新:', message.status);
            }
        } catch (e) {
            console.error('解析消息错误:', e);
            showError('解析消息错误');
        }
    };
    
    socket.onerror = (error) => {
        console.error('WebSocket 错误:', error);
        updateStatus('disconnected', '连接错误');
        showError('WebSocket 连接错误');
    };
    
    socket.onclose = (event) => {
        console.log('WebSocket 连接已关闭, 代码:', event.code, '原因:', event.reason);
        updateStatus('disconnected', '已断开连接');
        
        // 尝试重连，除非是正常关闭
        if (event.code !== 1000 && event.code !== 1001) {
            tryReconnect();
        }
    };
}

// 尝试重新连接
function tryReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('达到最大重连次数，停止重连');
        showError('无法连接到服务器，请刷新页面重试');
        return;
    }
    
    reconnectAttempts++;
    console.log(`尝试重连... (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    // 设置重连定时器
    reconnectTimer = setTimeout(() => {
        console.log('正在重新连接...');
        connectWebSocket();
    }, RECONNECT_INTERVAL);
}

// 显示错误消息
function showError(message) {
    // 可以在页面上显示错误消息
    console.error(message);
    // 如果是录音中遇到错误，停止录音
    if (isRecording) {
        stopRecording();
    }
}

// 更新状态指示器
function updateStatus(status, text) {
    statusIndicator.className = `status-indicator ${status}`;
    statusText.textContent = text;
}

// 存储最后一次识别和翻译的内容，避免重复
let lastRecognitionContent = '';
let lastTranslationContent = '';

// 根据标点划分句子
function splitIntoSentences(text) {
    // 定义需要划分的标点符号（中英文标点都包括）
    const punctuations = ['.', '。', '!', '！', '?', '？', ';', '；', ':', '：'];
    let sentences = [];
    let currentSentence = '';
    
    for (let i = 0; i < text.length; i++) {
        currentSentence += text[i];
        
        if (punctuations.includes(text[i]) && i < text.length - 1) {
            sentences.push(currentSentence);
            currentSentence = '';
        }
    }
    
    // 添加最后一个未结束的句子
    if (currentSentence.length > 0) {
        sentences.push(currentSentence);
    }
    
    return sentences;
}

// 创建并管理字幕队列
const MAX_CAPTIONS = 7; // 保持固定7行文字

// 管理字幕队列
function manageCaptions(container, text) {
    if (!text || !text.trim()) return;
    
    // 获取所有字幕
    const captions = container.querySelectorAll('.caption');
    
    // 判断是否需要移除旧字幕
    if (captions.length >= MAX_CAPTIONS) {
        // 移除最早的字幕，添加淡出效果
        const oldestCaption = captions[0];
        oldestCaption.classList.add('fading');
        
        // 等待淡出动画完成后删除
        setTimeout(() => {
            if (oldestCaption.parentNode === container) {
                container.removeChild(oldestCaption);
            }
        }, 500);
    }
    
    // 创建新字幕
    const newCaption = document.createElement('div');
    newCaption.className = 'caption';
    newCaption.textContent = text;
    container.appendChild(newCaption);
    
    // 使用setTimeout确保过渡效果生效
    setTimeout(() => {
        newCaption.classList.add('visible');
    }, 50);
    
    // 重新定位所有字幕，创建上滚效果
    setTimeout(() => {
        updateCaptionsPosition(container);
    }, 100);
}

// 更新所有字幕的位置
function updateCaptionsPosition(container) {
    const captions = container.querySelectorAll('.caption');
    
    // 将最新的字幕放在最下面，最早的字幕放在最上面
    captions.forEach((caption, index) => {
        // 计算相对于底部的位置
        const bottomOffset = (captions.length - 1 - index) * 30; // 每行30px的高度
        caption.style.position = 'absolute';
        caption.style.bottom = `${bottomOffset}px`;
        caption.style.left = '0';
        caption.style.right = '0';
    });
}

// 更新识别和翻译文本
function updateRecognitionAndTranslation(data) {
    // 处理识别结果
    if (data.recognition) {
        // 直接使用识别结果
        let recognitionContent = data.recognition;
        
        // 打印调试信息
        console.log('原始识别数据:', data.recognition);
        console.log('处理后的识别内容:', recognitionContent);
        
        console.log('识别内容:', recognitionContent);
        
        // 如果有内容，按句子分割并显示
        if (recognitionContent && recognitionContent.trim()) {
            // 先将新的完整内容设置到文本区
            recognitionText.textContent = recognitionContent;
            
            // 对内容进行句子分割，适合字幕显示
            const sentences = splitIntoSentences(recognitionContent);
            
            if (sentences.length > 0) {
                // 只显示最后一个句子，避免重复显示
                const latestSentence = sentences[sentences.length - 1];
                if (latestSentence.trim()) {
                    manageCaptions(recognitionCaptions, latestSentence);
                }
            }
        }
        
        lastRecognitionContent = recognitionContent;
    }

    // 处理翻译结果
    if (data.translation) {
        // 直接使用翻译结果
        let translationContent = data.translation;
        
        // 打印调试信息
        console.log('原始翻译数据:', data.translation);
        console.log('处理后的翻译内容:', translationContent);
        
        console.log('翻译内容:', translationContent);
        
        // 如果有内容，按句子分割并显示
        if (translationContent && translationContent.trim()) {
            // 先将新的完整内容设置到文本区
            translationText.textContent = translationContent;
            
            // 对内容进行句子分割，适合字幕显示
            const sentences = splitIntoSentences(translationContent);
            
            if (sentences.length > 0) {
                // 只显示最后一个句子，避免重复显示
                const latestSentence = sentences[sentences.length - 1];
                if (latestSentence.trim()) {
                    manageCaptions(translationCaptions, latestSentence);
                }
            }
        }
        
        lastTranslationContent = translationContent;
    }
}

// 开始录音和实时翻译
async function startRecording() {
    if (isRecording) return;
    
    try {
        // 清空之前的文本
        recognitionText.textContent = '';
        translationText.textContent = '';
        recognitionCaptions.innerHTML = '';
        translationCaptions.innerHTML = '';
        
        // 确保连接到 WebSocket 服务器
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            updateStatus('connecting', '正在连接服务器...');
            connectWebSocket();
            
            // 等待连接建立
            await new Promise((resolve, reject) => {
                let checkInterval = setInterval(() => {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        clearInterval(checkInterval);
                        resolve();
                    }
                }, 100);
                
                // 10秒超时
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error('连接服务器超时'));
                }, 10000);
            });
        }
        
        // 初始化录音器
        if (!recorder) {
            initRecorder();
        }
        
        // 启动录音
        await recorder.connect(sendAudioData);
        isRecording = true;
        
        // 更新 UI
        startButton.disabled = true;
        stopButton.disabled = false;
        updateStatus('processing', '正在识别中...');
        
    } catch (error) {
        console.error('开始录音错误:', error);
        updateStatus('disconnected', '录音失败');
        showError('无法启动录音：' + error.message);
    }
}

// 停止录音
function stopRecording() {
    if (!isRecording) return;
    
    try {
        // 停止录音
        if (recorder) {
            recorder.stop();
        }
        
        // 发送停止消息和最后一帧（空数据）到服务器
        if (socket && socket.readyState === WebSocket.OPEN) {
            // 首先发送最后一帧空音频数据
            socket.send(JSON.stringify({
                type: 'audio',
                data: '',  // 空数据表示结束
                isLast: true
            }));
            
            // 然后发送停止命令
            socket.send(JSON.stringify({
                type: 'stop'
            }));
        } else {
            console.warn('WebSocket连接已断开，无法发送停止信号');
        }
        
        isRecording = false;
        
        // 更新 UI
        startButton.disabled = false;
        stopButton.disabled = true;
        updateStatus('connected', '处理中...');
        
    } catch (error) {
        console.error('停止录音错误:', error);
        showError('停止录音时出错');
        
        // 确保状态重置
        isRecording = false;
        startButton.disabled = false;
        stopButton.disabled = true;
    }
}

// 发送音频数据到服务器
function sendAudioData(audioData) {
    // 检查连接和录音状态
    if (!isRecording) return;
    
    // 检查连接状态，如果断开则尝试重连
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.warn('WebSocket 连接已断开，尝试重连...');
        connectWebSocket();
        // 为了防止数据丢失，这里可以缓存一小部分音频数据，但这里简化处理
        return;
    }
    
    try {
        // 将 Int16Array 转换为常规数组
        const buffer = new ArrayBuffer(audioData.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < audioData.length; i++) {
            view.setInt16(i * 2, audioData[i], true);
        }
        
        // 转换为 Base64
        const audioBase64 = arrayBufferToBase64(buffer);
        
        // 发送到服务器
        socket.send(JSON.stringify({
            type: 'audio',
            data: audioBase64,
            isLast: false
        }));
    } catch (error) {
        console.error('发送音频数据错误:', error);
        showError('处理音频时出错');
        
        // 发生错误时短暂暂停，然后重试连接
        if (isRecording) {
            setTimeout(() => {
                if (isRecording) {
                    connectWebSocket();
                }
            }, 1000);
        }
    }
}

// ArrayBuffer 转 Base64
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// 注册事件监听器
startButton.addEventListener('click', startRecording);
stopButton.addEventListener('click', stopRecording);

// 在页面加载时初始化音频和连接WebSocket服务器
window.addEventListener('load', () => {
    try {
        // 连接WebSocket服务器
        connectWebSocket();
        
        // 初始化录音器
        initRecorder();
    } catch (error) {
        console.error('初始化错误:', error);
        showError('初始化失败: ' + error.message);
    }
});

// 在页面关闭时断开连接
window.addEventListener('beforeunload', () => {
    if (recorder) {
        recorder.stop();
    }
    if (socket) {
        socket.close();
    }
});
