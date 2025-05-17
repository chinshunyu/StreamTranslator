/**
 * PCM Audio Recorder
 * 用于捕获麦克风音频并转换为PCM格式
 */
class PCMAudioRecorder {
    constructor(options = {}) {
        // 默认配置
        this.config = {
            sampleRate: 16000,           // 采样率
            bufferSize: 4096,            // 缓冲区大小
            numChannels: 1,              // 单声道
            bitsPerSample: 16            // 16位
        };
        
        // 合并用户配置
        Object.assign(this.config, options);
        
        // 初始化状态
        this.isRecording = false;
        this.audioContext = null;
        this.mediaStream = null;
        this.processor = null;
        this.callback = null;
    }
    
    /**
     * 连接麦克风并开始录音
     * @param {Function} callback - 接收音频数据的回调函数
     * @returns {Promise} - 返回Promise
     */
    async connect(callback) {
        if (this.isRecording) {
            throw new Error('已经在录音中');
        }
        
        if (!callback || typeof callback !== 'function') {
            throw new Error('必须提供回调函数');
        }
        
        this.callback = callback;
        
        try {
            // 请求麦克风权限
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            // 创建音频上下文
            window.AudioContext = window.AudioContext || window.webkitAudioContext;
            this.audioContext = new AudioContext();
            
            // 创建麦克风输入源
            const source = this.audioContext.createMediaStreamSource(this.mediaStream);
            
            // 创建处理节点
            this.processor = this.audioContext.createScriptProcessor(
                this.config.bufferSize,
                this.config.numChannels,
                this.config.numChannels
            );
            
            // 设置处理函数
            this.processor.onaudioprocess = this._processAudioData.bind(this);
            
            // 连接节点
            source.connect(this.processor);
            this.processor.connect(this.audioContext.destination);
            
            // 更新状态
            this.isRecording = true;
            
            console.log('录音开始，采样率:', this.audioContext.sampleRate);
            
            return true;
        } catch (error) {
            console.error('录音初始化失败:', error);
            this._cleanupResources();
            throw error;
        }
    }
    
    /**
     * 处理音频数据
     * @param {AudioProcessingEvent} event - 音频处理事件
     * @private
     */
    _processAudioData(event) {
        if (!this.isRecording) return;
        
        // 获取音频数据
        const inputData = event.inputBuffer.getChannelData(0);
        
        // 重采样到目标采样率（如果需要）
        const audioData = this._resampleIfNeeded(inputData);
        
        // 转换为16位整数
        const pcmData = this._floatTo16BitPCM(audioData);
        
        // 回调函数处理数据
        if (this.callback) {
            this.callback(pcmData);
        }
    }
    
    /**
     * 如果需要，重采样音频数据
     * @param {Float32Array} inputData - 输入的音频数据
     * @returns {Float32Array} - 重采样后的数据
     * @private
     */
    _resampleIfNeeded(inputData) {
        const sourceSampleRate = this.audioContext.sampleRate;
        const targetSampleRate = this.config.sampleRate;
        
        // 如果采样率相同，直接返回
        if (sourceSampleRate === targetSampleRate) {
            return inputData;
        }
        
        // 计算重采样后的数据长度
        const outputLength = Math.round(inputData.length * targetSampleRate / sourceSampleRate);
        const outputData = new Float32Array(outputLength);
        
        // 线性插值重采样
        for (let i = 0; i < outputLength; i++) {
            const position = i * sourceSampleRate / targetSampleRate;
            const index = Math.floor(position);
            const fraction = position - index;
            
            // 边界检查
            if (index >= inputData.length - 1) {
                outputData[i] = inputData[inputData.length - 1];
            } else {
                // 线性插值
                outputData[i] = inputData[index] * (1 - fraction) + inputData[index + 1] * fraction;
            }
        }
        
        return outputData;
    }
    
    /**
     * 将Float32Array转换为Int16Array (16位PCM)
     * @param {Float32Array} floatData - 浮点音频数据
     * @returns {Int16Array} - 16位PCM数据
     * @private
     */
    _floatTo16BitPCM(floatData) {
        const pcmData = new Int16Array(floatData.length);
        
        // 转换浮点数到16位整数
        for (let i = 0; i < floatData.length; i++) {
            // 将-1.0到1.0的浮点数映射到-32768到32767的整数
            const s = Math.max(-1, Math.min(1, floatData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        return pcmData;
    }
    
    /**
     * 停止录音
     */
    stop() {
        if (!this.isRecording) return;
        
        this._cleanupResources();
        console.log('录音已停止');
    }
    
    /**
     * 清理资源
     * @private
     */
    _cleanupResources() {
        // 断开处理节点
        if (this.processor) {
            this.processor.disconnect();
            this.processor.onaudioprocess = null;
            this.processor = null;
        }
        
        // 停止所有音轨
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        
        // 关闭音频上下文
        if (this.audioContext && this.audioContext.state !== 'closed') {
            // 某些浏览器不支持关闭AudioContext
            if (this.audioContext.close) {
                this.audioContext.close();
            }
            this.audioContext = null;
        }
        
        // 重置状态
        this.isRecording = false;
        this.callback = null;
    }
}

export default PCMAudioRecorder;
