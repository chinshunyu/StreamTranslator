import asyncio
import base64
import json
import logging
import uuid
from typing import Dict, List, Optional, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel
import os
from AuthV4Util import addAuthParams
from WebSocketUtil import init_connection_with_params, send_binary_message
from dotenv import load_dotenv

load_dotenv()

# 配置日志 
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('speech-translation-server')

# 有道智云API配置
APP_KEY = os.getenv('APP_KEY')  # 您的应用ID
APP_SECRET = os.getenv('APP_SECRET')  # 您的应用密钥
API_URL = 'wss://openapi.youdao.com/stream_speech_trans'

# 创建FastAPI应用
app = FastAPI(title="实时语音翻译系统")

# 添加CORS中间件，允许跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 允许所有来源，也可以指定特定域名 ["http://localhost:8000", "https://example.com"]
    allow_credentials=True,
    allow_methods=["*"],  # 允许所有方法
    allow_headers=["*"],  # 允许所有头
)

# 保存客户端连接
clients: Dict[str, WebSocket] = {}
# 保存翻译会话
translation_sessions: Dict[str, 'TranslationSession'] = {}


class TranslationSession:
    """翻译会话类，管理与有道API的连接"""
    
    def __init__(self, client_id, lang_from='zh-CHS', lang_to='en'):
        self.client_id = client_id
        self.lang_from = lang_from
        self.lang_to = lang_to
        self.ws_client = None
        self.is_connected = False
        self.buffer = []
        self.is_processing = False
        
    async def connect(self):
        """连接到有道翻译API"""
        try:
            # 设置API参数
            data = {
                'from': self.lang_from, 
                'to': self.lang_to, 
                'format': 'wav', 
                'channel': '1', 
                'version': 'v1', 
                'rate': '16000'
            }
            
            # 添加鉴权参数
            addAuthParams(APP_KEY, APP_SECRET, data)
            
            # 创建websocket连接
            self.ws_client = init_connection_with_params(API_URL, data)
            
            # 修改WebSocketUtil中的回调函数，使其将消息发送回客户端
            original_on_message = self.ws_client.ws.on_message
            
            # 创建一个回调函数，它会安全地处理消息
            def on_message_wrapper(ws, message):
                # 调用原始回调
                original_on_message(ws, message)
                
                # 将消息添加到缓冲区，由主线程处理
                logger.info(f"收到消息: {message}")
                self.buffer.append(message)
                
                # 不在回调中直接调用异步函数
                
            self.ws_client.ws.on_message = on_message_wrapper
            
            # 启动定期处理缓冲区消息的任务
            asyncio.create_task(self.process_buffer())
            
            # 等待连接建立
            while not self.ws_client.return_is_connect():
                await asyncio.sleep(0.1)
                
            self.is_connected = True
            logger.info(f"已连接到有道翻译API: 会话ID {self.client_id}")
            return True
            
        except Exception as e:
            logger.error(f"连接到有道翻译API失败: {str(e)}")
            self.is_connected = False
            return False
    
    async def process_buffer(self):
        """定期处理缓冲区中的消息"""
        while True:
            # 如果缓冲区有消息并且没有正在处理
            if self.buffer and not self.is_processing:
                self.is_processing = True
                try:
                    # 获取并处理第一条消息
                    message = self.buffer.pop(0)
                    await self.handle_translation_result(message)
                except Exception as e:
                    logger.error(f"处理缓冲区消息错误: {str(e)}")
                    import traceback
                    logger.error(traceback.format_exc())
                finally:
                    self.is_processing = False
            
            # 等待一小段时间再检查
            await asyncio.sleep(0.1)
    
    async def handle_translation_result(self, message):
        """处理翻译结果并发送到客户端"""
        try:
            # 解析JSON消息
            result = json.loads(message)
            
            # 检查是否有错误
            if result.get('errorCode') != '0':
                error_msg = result.get('errorMessage', '未知错误')
                logger.error(f"翻译API错误: {error_msg}")
                
                # 发送错误消息到客户端
                if self.client_id in clients:
                    await clients[self.client_id].send_json({
                        'type': 'error',
                        'message': error_msg
                    })
                return
            
            # 提取识别和翻译结果
            recognition = result['result'].get('context', '')
            translation = result['result'].get('tranContent', '')
            is_final = result.get('end', False)
            
            # 打印结果以便调试
            logger.info(f"识别结果: {recognition}")
            logger.info(f"翻译结果: {translation}")
            
            # 发送结果到客户端
            if self.client_id in clients:
                message_type = 'final_results' if is_final else 'results'
                # 准备发送给前端的消息
                message_to_send = {
                    'type': message_type,
                    'data': {
                        'recognition': recognition,
                        'translation': translation
                    }
                }
                
                # 打印将要发送的消息
                logger.info(f"发送给前端的消息: {json.dumps(message_to_send)}")
                
                # 发送消息
                await clients[self.client_id].send_json(message_to_send)
                
                logger.info(f"发送翻译结果到客户端 {self.client_id}: {recognition} -> {translation}")
                
        except Exception as e:
            logger.error(f"处理翻译结果失败: {str(e)}")
    
    async def send_audio(self, audio_data, is_last=False):
        """发送音频数据到有道API"""
        # 如果未连接，尝试连接
        if not self.is_connected or not self.ws_client:
            logger.warning("尝试发送音频但未连接到有道API，尝试连接...")
            success = await self.connect()
            if not success:
                logger.error("无法连接到有道API，无法发送音频数据")
                return False
        
        try:
            # 进一步检查WebSocket连接状态
            if not self.ws_client or not self.ws_client.ws or self.ws_client.ws.sock is None:
                logger.warning(f"WebSocket连接已关闭，尝试重新连接到有道API: 会话ID {self.client_id}")
                success = await self.connect()
                if not success:
                    logger.error(f"重新连接到有道API失败: 会话ID {self.client_id}")
                    return False
                logger.info(f"已重新连接到有道API: 会话ID {self.client_id}")
            
            # 如果是Base64编码的数据，先解码
            if isinstance(audio_data, str) and audio_data:
                audio_bytes = base64.b64decode(audio_data)
            elif isinstance(audio_data, bytes):
                audio_bytes = audio_data
            else:
                audio_bytes = b''
            
            # 发送二进制音频数据
            if audio_bytes:
                # 使用WebSocketUtil中的send_binary_message函数
                try:
                    send_binary_message(self.ws_client.ws, audio_bytes)
                    logger.debug(f"已发送 {len(audio_bytes)} 字节的音频数据")
                    return True
                except Exception as e:
                    logger.error(f"发送音频数据失败: {str(e)}")
                    return False
            else:
                logger.warning("没有有效的音频数据可发送")
                return False
                
        except Exception as e:
            logger.error(f"发送音频数据时出错: {str(e)}")
            return False
            
    async def close(self):
        """关闭翻译会话"""
        try:
            if self.ws_client and self.ws_client.ws:
                self.ws_client.ws.close()
            self.is_connected = False
            logger.info(f"已关闭与有道API的连接: 会话ID {self.client_id}")
        except Exception as e:
            logger.error(f"关闭与有道API的连接时出错: {str(e)}")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    
    # 生成客户端ID
    client_id = str(uuid.uuid4())
    clients[client_id] = websocket
    
    # 创建翻译会话
    session = TranslationSession(client_id)
    translation_sessions[client_id] = session
    
    # 连接到有道API
    await session.connect()
    
    try:
        # 发送连接成功消息
        await websocket.send_json({
            'type': 'connection',
            'status': 'connected',
            'client_id': client_id
        })
        
        # 处理客户端消息
        while True:
            data = await websocket.receive_text()
            
            try:
                message = json.loads(data)
                
                if message.get('type') == 'audio':
                    # 处理音频数据
                    audio_data = message.get('data')
                    is_last = message.get('is_last', False)
                    
                    if audio_data:
                        # 发送到有道API
                        await session.send_audio(audio_data, is_last)
                    
                elif message.get('type') == 'config':
                    # 处理配置更新
                    config = message.get('data', {})
                    lang_from = config.get('from', session.lang_from)
                    lang_to = config.get('to', session.lang_to)
                    
                    # 如果语言设置变化，重新创建会话
                    if lang_from != session.lang_from or lang_to != session.lang_to:
                        # 关闭旧会话
                        await session.close()
                        
                        # 创建新会话
                        session = TranslationSession(client_id, lang_from, lang_to)
                        translation_sessions[client_id] = session
                        
                        # 连接到有道API
                        await session.connect()
                        
                        await websocket.send_json({
                            'type': 'config_updated',
                            'data': {
                                'from': lang_from,
                                'to': lang_to
                            }
                        })
                
            except json.JSONDecodeError:
                logger.error(f"无法解析JSON消息: {data}")
                await websocket.send_json({
                    'type': 'error',
                    'message': '无效的JSON格式'
                })
                
            except Exception as e:
                logger.error(f"处理客户端消息时出错: {str(e)}")
                await websocket.send_json({
                    'type': 'error',
                    'message': f'处理消息时出错: {str(e)}'
                })
                
    except WebSocketDisconnect:
        logger.info(f"客户端断开连接: {client_id}")
    except Exception as e:
        logger.error(f"WebSocket连接错误: {str(e)}")
    finally:
        # 清理资源
        if client_id in clients:
            del clients[client_id]
        
        if client_id in translation_sessions:
            # 关闭翻译会话
            await translation_sessions[client_id].close()
            del translation_sessions[client_id]


# 提供静态文件服务
# 先挂载静态目录
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def get_index():
    # 返回index.html
    return FileResponse("static/index.html")


# 为了兼容性，添加直接访问根目录下文件的路由
@app.get("/main.js")
async def get_main_js():
    return FileResponse("static/main.js")


@app.get("/audio_recorder.js")
async def get_audio_recorder_js():
    return FileResponse("static/audio_recorder.js")


@app.get("/styles.css")
async def get_styles_css():
    return FileResponse("static/styles.css")


@app.get("/favicon.ico", include_in_schema=False)
async def get_favicon():
    # 返回favicon.ico（如果存在）或空响应
    return Response(content=b"", media_type="image/x-icon")


if __name__ == "__main__":
    import uvicorn
    # 启动服务器
    uvicorn.run("fastapi_app:app", host="0.0.0.0", port=8000, reload=True)
