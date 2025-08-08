class WebSocketHandler {
    constructor() {
        // Session variables
        this.peerConnection = null;
        this.dataChannel = null;
        this.audioElement = null;
        this.sessionId = null;
        this.ephemeralKey = null;
        this.currentConfig = null;
        
        // Transcript tracking
        this.currentAssistantMessageElement = null;
        this.currentAssistantContentElement = null;
        this.currentTranscript = '';
    }
    
    async startSession(config) {
        try {
            this.currentConfig = config;
            this.log('Starting session with configuration:', config);
            
            // Step 1: Get ephemeral key
            await this.getEphemeralKey();
            
            // Step 2: Initialize WebRTC connection
            await this.initializeWebRTC();
            
            // Step 3: Set up audio and data channels
            await this.setupAudioAndDataChannels();
            
            // Step 4: Create and send SDP offer
            await this.createAndSendOffer();
            
        } catch (error) {
            this.log('Error starting session:', error);
            if (window.domHandler) {
                window.domHandler.onSessionError(error.message);
            }
        }
    }
    
    async getEphemeralKey() {
        this.log('Fetching ephemeral key...');
        
        // Build the session creation payload with all configuration options
        const sessionPayload = {
            model: this.currentConfig.model,
            voice: this.currentConfig.voice,
            instructions: this.currentConfig.instructions,
            input_audio_format: this.currentConfig.input_audio_format,
            output_audio_format: this.currentConfig.output_audio_format,
            temperature: this.currentConfig.temperature,
            max_response_output_tokens: this.currentConfig.max_response_output_tokens,
            modalities: this.currentConfig.modalities
        };

        console.log(sessionPayload)
        
        // Add turn detection configuration
        if (this.currentConfig.turn_detection_type && this.currentConfig.turn_detection_type !== 'none') {
            if (this.currentConfig.turn_detection_type === 'server_vad') {
                sessionPayload.turn_detection = {
                    type: 'server_vad',
                    threshold: this.currentConfig.threshold,
                    prefix_padding_ms: this.currentConfig.prefix_padding_ms,
                    silence_duration_ms: this.currentConfig.silence_duration_ms,
                    create_response: this.currentConfig.create_response,
                    interrupt_response: this.currentConfig.interrupt_response
                };
            } else if (this.currentConfig.turn_detection_type === 'semantic_vad') {
                sessionPayload.turn_detection = {
                    type: 'semantic_vad',
                    eagerness: this.currentConfig.eagerness,
                    create_response: this.currentConfig.create_response,
                    interrupt_response: this.currentConfig.interrupt_response
                };
            }
        }
        
        // Add noise reduction configuration
        if (this.currentConfig.input_audio_noise_reduction) {
            sessionPayload.input_audio_noise_reduction = this.currentConfig.input_audio_noise_reduction;
        }
        
        // Add transcription configuration
        if (this.currentConfig.input_audio_transcription) {
            sessionPayload.input_audio_transcription = this.currentConfig.input_audio_transcription;
        }


        const response = await fetch(this.currentConfig.sessionUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.currentConfig.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(sessionPayload)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API request failed with status: ${response.status}. ${errorText}`);
        }
        
        const data = await response.json();
        this.sessionId = data.id;
        this.ephemeralKey = data.client_secret?.value;
        
        this.log('Ephemeral key received successfully');
        this.log('Session ID:', this.sessionId);
    }
    
    async initializeWebRTC() {
        this.log('Initializing WebRTC connection...');
        
        this.peerConnection = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        
        // Set up audio element for playback
        this.audioElement = document.getElementById('audioElement');
        
        // Handle incoming audio tracks
        this.peerConnection.ontrack = (event) => {
            this.log('Received remote audio track');
            this.audioElement.srcObject = event.streams[0];
        };
        
        // Handle connection state changes
        this.peerConnection.onconnectionstatechange = () => {
            this.log('Connection state:', this.peerConnection.connectionState);
            
            switch (this.peerConnection.connectionState) {
                case 'connected':
                    if (window.domHandler) {
                        window.domHandler.onSessionConnected();
                    }
                    break;
                case 'disconnected':
                case 'failed':
                case 'closed':
                    if (window.domHandler) {
                        window.domHandler.onSessionDisconnected();
                    }
                    break;
            }
        };
    }
    
    async setupAudioAndDataChannels() {
        this.log('Setting up audio and data channels...');
        
        // Get user microphone
        try {
            const clientMedia = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });
            
            const audioTrack = clientMedia.getAudioTracks()[0];
            this.peerConnection.addTrack(audioTrack, clientMedia);
            this.log('Microphone audio track added');
            
        } catch (error) {
            throw new Error('Failed to access microphone: ' + error.message);
        }
        
        // Create data channel for control messages
        this.dataChannel = this.peerConnection.createDataChannel('realtime-channel');
        
        this.dataChannel.addEventListener('open', () => {
            this.log('Data channel opened');
            this.updateSessionConfiguration();
        });
        
        this.dataChannel.addEventListener('message', (event) => {
            this.handleServerMessage(event.data);
        });
        
        this.dataChannel.addEventListener('close', () => {
            this.log('Data channel closed');
        });
        
        this.dataChannel.addEventListener('error', (error) => {
            this.log('Data channel error:', error);
        });
    }
    
    async createAndSendOffer() {
        this.log('Creating and sending SDP offer...');
        
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);
        
        const sdpResponse = await fetch(`${this.currentConfig.webrtcUrl}?model=${this.currentConfig.model}`, {
            method: "POST",
            body: offer.sdp,
            headers: {
                Authorization: `Bearer ${this.ephemeralKey}`,
                "Content-Type": "application/sdp",
            },
        });
        
        if (!sdpResponse.ok) {
            throw new Error(`SDP request failed with status: ${sdpResponse.status}`);
        }
        
        const answerSdp = await sdpResponse.text();
        const answer = { type: "answer", sdp: answerSdp };
        await this.peerConnection.setRemoteDescription(answer);
        
        this.log('SDP exchange completed successfully');
    }
    
    updateSessionConfiguration() {
        // Since we're now configuring the session during creation,
        // we don't need to send additional session.update events
        // unless we want to change something mid-session
        this.log('Session configuration applied during creation');
    }
    
    sendMessage(message) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(JSON.stringify(message));
            this.log('Sent message:', message.type);
        } else {
            this.log('Cannot send message: data channel not ready');
        }
    }
    
    handleServerMessage(data) {
        try {
            const message = JSON.parse(data);
            this.log('Received server message:', message.type);
            //console.log('📡 RECEIVED MESSAGE:', message.type, message);
            
            // Validate message structure
            if (!message.type) {
                this.log('Warning: received message without type field');
                console.warn('❌ Message without type field:', message);
                return;
            }
            
            switch (message.type) {
                case 'session.created':
                    this.log('Session created successfully');
                    break;
                    
                case 'session.updated':
                    this.log('Session updated successfully');
                    break;
                    
                case 'conversation.item.created':
                    this.log('Conversation item created');
                    if (message.item?.type === 'message' && message.item?.role === 'user') {
                        // User started speaking - show typing indicator for assistant
                        if (window.domHandler) {
                            window.domHandler.showTypingIndicator();
                        }
                    }
                    break;
                    
                case 'input_audio_buffer.speech_started':
                    this.log('User started speaking');
                    if (window.domHandler) {
                        window.domHandler.showTypingIndicator();
                    }
                    break;
                    
                case 'input_audio_buffer.speech_stopped':
                    this.log('User stopped speaking');
                    break;
                    
                case 'conversation.item.input_audio_transcription.completed':
                    if (!message.transcript) {
                        this.log('Warning: received user transcription event without transcript field');
                        console.warn('❌ User transcription event missing transcript field:', message);
                        break;
                    }
                    
                    this.log('User audio transcription completed:', message.transcript);
                    //console.log('🎤 USER TRANSCRIPT:', message.transcript);
                    //console.log('📝 Full transcription event:', message);
                    
                    if (window.domHandler) {
                        window.domHandler.addUserTranscription(message.transcript);
                        
                        // Log additional metadata
                        this.log('User transcription metadata:', {
                            item_id: message.item_id,
                            content_index: message.content_index,
                            event_id: message.event_id
                        });
                        
                        // Log usage information if available
                        if (message.usage) {
                            this.log('Transcription usage:', {
                                total_tokens: message.usage.total_tokens,
                                input_tokens: message.usage.input_tokens,
                                output_tokens: message.usage.output_tokens,
                                input_token_details: message.usage.input_token_details
                            });
                        }
                    } else {
                        console.error('❌ domHandler not available for user transcription');
                    }
                    break;
                    
                case 'response.audio.transcript.delta':
                    // Add console logging for delta transcripts
                    // if (window.domHandler && message.delta) {
                    //     //console.log('🔄 ASSISTANT TRANSCRIPT DELTA:', message.delta);
                    //     this.updateAssistantTranscript(message.delta);
                    // } else if (message.delta === undefined) {
                        this.log('Warning: received response.audio.transcript.delta without delta field');
                        console.warn('❌ Assistant transcript delta missing delta field:', message);
                    // }
                    break;
                    
                case 'response.audio_transcript.done':
                    this.log('Assistant audio transcript completed:', message.transcript);
                    //console.log('🤖 ASSISTANT TRANSCRIPT COMPLETE:', message.transcript);
                    //console.log('📝 Full transcript done event:', message);
                    
                    if (window.domHandler && message.transcript) {
                        // this.finalizeAssistantTranscript(message.transcript);
                        window.domHandler.addAssistantTranscription(message.transcript);
                        // Log transcript metadata
                        this.log('Transcript metadata:', {
                            response_id: message.response_id,
                            item_id: message.item_id,
                            output_index: message.output_index,
                            content_index: message.content_index
                        });
                    } else if (!message.transcript) {
                        console.error('❌ Assistant transcript done event missing transcript field:', message);
                    } else {
                        console.error('❌ domHandler not available for assistant transcription');
                    }
                    break;
                    
                case 'response.done':
                    this.log('Response completed');
                    if (window.domHandler) {
                        window.domHandler.removeTypingIndicator();
                    }
                    break;
                    
                case 'error':
                    this.log('Server error:', message.error);
                    if (window.domHandler) {
                        window.domHandler.onSessionError(message.error.message || 'Unknown server error');
                        window.domHandler.removeTypingIndicator();
                    }
                    break;
                    
                default:
                    this.log('Unhandled message type:', message.type);
            }
            
        } catch (error) {
            this.log('Error parsing server message:', error);
        }
    }
    
    updateAssistantTranscript(delta) {
        //console.log('🔄 Updating assistant transcript with delta:', delta);
        
        // Find or create the current assistant message being transcribed
        if (!this.currentAssistantMessageElement) {
            //console.log('📝 Creating new assistant message element');
            
            // Remove typing indicator and create new message
            if (window.domHandler) {
                window.domHandler.removeTypingIndicator();
            }
            
            this.currentAssistantMessageElement = document.createElement('div');
            this.currentAssistantMessageElement.className = 'message assistant';
            
            this.currentAssistantContentElement = document.createElement('div');
            this.currentAssistantMessageElement.appendChild(this.currentAssistantContentElement);
            
            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = new Date().toLocaleTimeString();
            this.currentAssistantMessageElement.appendChild(timeDiv);
            
            if (window.domHandler) {
                window.domHandler.elements.chatMessages.appendChild(this.currentAssistantMessageElement);
                //console.log('✅ Assistant message element added to DOM');
            } else {
                console.error('❌ domHandler not available for assistant message creation');
            }
            
            this.currentTranscript = '';
        }
        
        // Append the delta to the current transcript
        this.currentTranscript += delta;
        if (this.currentAssistantContentElement) {
            this.currentAssistantContentElement.textContent = this.currentTranscript;
            //console.log('📝 Updated assistant transcript:', this.currentTranscript);
        } else {
            console.error('❌ currentAssistantContentElement not available');
        }
        
        // Scroll to bottom
        if (window.domHandler) {
            window.domHandler.scrollChatToBottom();
        }
    }
    
    finalizeAssistantTranscript(finalTranscript) {
        //console.log('✅ Finalizing assistant transcript:', finalTranscript);
        this.addAssistantTranscription(finalTranscript);
        // Update with the final transcript
        if (this.currentAssistantContentElement) {
            this.currentAssistantContentElement.textContent = finalTranscript;
            //console.log('📝 Final transcript set in DOM element');
        } else {
            console.error('❌ currentAssistantContentElement not available for finalization');
        }
        
        // Reset current message tracking
        this.currentAssistantMessageElement = null;
        this.currentAssistantContentElement = null;
        this.currentTranscript = '';
        
        // Scroll to bottom
        if (window.domHandler) {
            window.domHandler.scrollChatToBottom();
        }
    }
    
    stopSession() {
        this.log('Stopping session...');
        
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }
        
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        
        if (this.audioElement) {
            this.audioElement.srcObject = null;
        }
        
        this.sessionId = null;
        this.ephemeralKey = null;
        this.currentConfig = null;
        
        // Reset transcript tracking
        this.currentAssistantMessageElement = null;
        this.currentAssistantContentElement = null;
        this.currentTranscript = '';
        
        this.log('Session stopped');
        
        if (window.domHandler) {
            window.domHandler.onSessionDisconnected();
        }
    }
    
    log(message, ...args) {
        //console.log(`[WebSocket] ${message}`, ...args);
        
        if (window.domHandler) {
            const logMessage = args.length > 0 ? `${message} ${JSON.stringify(args)}` : message;
            window.domHandler.logMessage(logMessage);
        }
    }
}

// Initialize WebSocket handler when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.websocketHandler = new WebSocketHandler();
});
