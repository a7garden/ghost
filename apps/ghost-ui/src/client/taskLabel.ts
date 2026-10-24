import type { Conversation, Task } from './types';

/** 호스트가 자동 생성한 응답 작업은 사람이 읽을 대화 제목으로 표시한다. */
export const taskDisplayLabel = (task: Task, conversation: Conversation) => task.name === '응답 생성' ? conversation.title : task.name;
