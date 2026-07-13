import { pipeline, env } from '@huggingface/transformers';

declare global {
    namespace chrome {
        namespace runtime {
            const onMessage: {
                addListener(callback: (message: any, sender: any, sendResponse: (response: any) => void) => boolean | void): void;
            };
        }
    }
}

env.allowRemoteModels = true;
if (env.backends.onnx?.wasm) {
    env.backends.onnx.wasm.proxy = true;
}

let classifier: any;

async function initModel() {
    if (!classifier) {
        classifier = await pipeline('text-classification', 'google/gemma-3n-e4b-it', {
            device: 'webgpu',
            dtype: 'q4',
        });
    }
}

interface MisInfoMessage {
    type: 'check_misinfo';
    text: string;
}

chrome.runtime.onMessage.addListener((message: MisInfoMessage, sendResponse: (response: any) => void) => {
    if (message.type === 'check_misinfo') {
        initModel().then(() => {
            return classifier(message.text);
        }).then((result) => {
            sendResponse(result);
        });
    }
    return true;
});