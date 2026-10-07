import { expect, it, vi } from 'vitest';
import { SpeechProbabilityStream } from './speechProbability';
import type { SpeechClassifier } from './speechProbability';
const settle = async () => { for (let i=0;i<100;i++) await Promise.resolve(); };
it('resamples and frames input before reporting actual speech probability', async () => {
 const classifier:SpeechClassifier={classify:vi.fn(async()=>.1),reset:vi.fn(),close:vi.fn(async()=>{})},frame=vi.fn(),error=vi.fn();const stream=new SpeechProbabilityStream(classifier,frame,error);
 stream.push(new Float32Array(2048).fill(.3),48000);await settle();expect(frame).toHaveBeenCalledTimes(1);expect(frame.mock.calls[0][0]).toHaveLength(512);expect(frame.mock.calls[0][1]).toBe(.1);expect(error).not.toHaveBeenCalled();stream.close();
});
it('drops an in-flight old classification after mute/reset without contaminating the next frame',async()=>{
 let resolve!:(value:number)=>void;const classifier:SpeechClassifier={classify:vi.fn().mockImplementationOnce(()=>new Promise<number>(r=>resolve=r)).mockResolvedValue(.9),reset:vi.fn(),close:vi.fn(async()=>{})},frame=vi.fn(),error=vi.fn();const stream=new SpeechProbabilityStream(classifier,frame,error);
 stream.push(new Float32Array(512).fill(.1),16000);stream.reset();stream.push(new Float32Array(512).fill(.2),16000);resolve(.99);await settle();expect(frame).toHaveBeenCalledTimes(1);expect(frame.mock.calls[0][0][0]).toBeCloseTo(.2);expect(error).not.toHaveBeenCalled();stream.close();
});
it('fails bounded slow inference instead of accumulating audio or falling back to energy',async()=>{
 let resolve!:(value:number)=>void;const classifier:SpeechClassifier={classify:vi.fn(()=>new Promise<number>(r=>resolve=r)),reset:vi.fn(),close:vi.fn(async()=>{})},frame=vi.fn(),error=vi.fn();const stream=new SpeechProbabilityStream(classifier,frame,error);
 stream.push(new Float32Array(32000),16000);stream.push(new Float32Array(1024),16000);expect(error).toHaveBeenCalledTimes(1);stream.close();resolve(.99);await settle();expect(frame).not.toHaveBeenCalled();expect(classifier.close).toHaveBeenCalledTimes(1);
});
it('rejects invalid model output and discards queued audio on close',async()=>{
 const classifier:SpeechClassifier={classify:vi.fn(async()=>NaN),reset:vi.fn(),close:vi.fn(async()=>{})},error=vi.fn(),frame=vi.fn();const stream=new SpeechProbabilityStream(classifier,frame,error);stream.push(new Float32Array(512),16000);await settle();expect(error).toHaveBeenCalledTimes(1);expect(frame).not.toHaveBeenCalled();stream.close();stream.push(new Float32Array(512),16000);await settle();expect(classifier.classify).toHaveBeenCalledTimes(1);
});
