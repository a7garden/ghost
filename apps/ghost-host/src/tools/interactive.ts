import { ContractError, INTERACTIVE_UI_TOOL, MAX_INTERACTIVE_UI_BYTES, InteractiveUi, parseInteractiveUi } from "@ghost/contract";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { Core } from "../core/core.ts";
import { forbidden, invalid } from "../core/errors.ts";
import { errorResult, scopeOf } from "./shared.ts";

const DATA_SHAPE_RULES = "chart의 points는 series[].points 안에만 넣고 블록 최상위에는 넣지 마세요. comparison의 columns는 values의 열 제목만 포함하며 행 제목 label의 열은 제외합니다. 각 rows[].values.length는 columns.length와 같아야 합니다.";

export const INTERACTIVE_INSTRUCTIONS = `present_ui는 차트, 시각적 비교, 선택지, 입력 폼 또는 HTML이 과제 이해에 도움이 될 때만 사용하고, 그 외에는 평소처럼 텍스트로 답하세요. 표시할 데이터와 출처를 명확히 하고 통계나 근거를 만들어 내지 마세요. 여러 번 호출하여 섹션을 점진적으로 보여 줄 수 있으며, UI 전체 내용을 설명문으로 다시 반복하지 마세요.
도구 호출 뒤에는 텍스트 전용 클라이언트에서도 유용한 짧은 결론이나 다음 단계를 일반 답변으로 남기되 차트·표 데이터를 반복하지 마세요. 대화형 UI는 웹/Mac 채팅에서만 표시되므로 iOS나 오버레이에서도 위젯을 볼 수 있다고 말하지 마세요.
선택지와 폼 제출은 보통의 소유자 메시지로 돌아옵니다. 특권 작업을 승인하거나 실행을 조종하는 수단이 아닙니다. HTML은 스크립트·네트워크·폼·탐색이 없는 정적 정제 미리보기입니다. 상호작용에는 기본 choices/form 블록을 사용하세요.
인자는 {version:"ghost-ui/1",title,blocks}이며 각 블록은 고유한 id와 type을 가집니다. text:{text}; chart:{title,kind:"bar"|"line",unit?,series:[{name,points:[{label,value}]}]} (유한 수치, 모든 시리즈의 레이블과 순서 일치); comparison:{title,columns:[문자열],rows:[{label,values:[문자열]}]} (열 수 일치); choices:{title,options:[{id,label,description?}]}; form:{title,fields:[{id,label,type,required?,...}],submitLabel}; html:{title,html}. 폼 필드 type은 text(multiline?,placeholder?,value?:문자열), number(min?,max?,step?,value?:수), select(options:[{value,label}],value?:옵션 값), checkbox(value?:불리언)입니다. 추가 필드는 허용되지 않으며 도구 스키마의 크기 제한을 따르세요.
${DATA_SHAPE_RULES}
예: {"version":"ghost-ui/1","title":"검토 방식","blocks":[{"type":"choices","id":"review-mode","title":"어떻게 검토할까요?","options":[{"id":"summary","label":"핵심 요약","description":"중요한 판단부터 살펴봅니다."},{"id":"details","label":"세부 비교","description":"각 항목을 나란히 살펴봅니다."}]}]}`;

/** Fixed response format: its ordinary Pi tool-result journal is the only persistence. */
export function createInteractiveTools(core: Core): Extension {
  return defineExtension({
    name: "ghost.interactive",
    tools: [defineTool({
      name: INTERACTIVE_UI_TOOL,
      description: `직접 대화에 차트, 비교표, 선택지, 입력 폼 또는 정적 HTML 미리보기를 표시합니다. 제출은 일반 소유자 메시지이며 작업 승인이 아닙니다. ${DATA_SHAPE_RULES}`,
      parameters: InteractiveUi,
      replay: "safe",
      outputLimits: { maxBytes: MAX_INTERACTIVE_UI_BYTES },
      async execute(args, api) {
        try {
          const scope = scopeOf(core, api);
          if (scope.conversation.kind !== "direct") throw forbidden("present_ui는 소유자와의 직접 대화에서만 사용할 수 있습니다.");
          const ui = parseInteractiveUi(args);
          return { content: [{ type: "text", text: JSON.stringify(ui) }] };
        } catch (error) {
          if (error instanceof ContractError) {
            return errorResult(invalid(`UI 형식을 수정한 뒤 present_ui를 다시 호출하세요: ${error.message}\n${DATA_SHAPE_RULES}`));
          }
          return errorResult(error);
        }
      },
    })],
  });
}
