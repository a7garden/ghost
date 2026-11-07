import { expect, test } from 'bun:test';
import { ContractError, formatUiSubmission, parseInteractiveUi, readInteractiveUi, type InteractiveUi } from '@ghost/contract';

function presentation(): InteractiveUi {
  return {
    version: 'ghost-ui/1', title: '견적 비교', blocks: [
      { type: 'chart', id: 'trend', title: '변화', kind: 'line', series: [
        { name: '첫째', points: [{ label: '전', value: -2 }, { label: '후', value: 0 }] },
        { name: '둘째', points: [{ label: '전', value: 0 }, { label: '후', value: 4 }] },
      ] },
      { type: 'choices', id: 'pick', title: '어느 안으로 진행할까요?', options: [{ id: 'a', label: 'A안', description: '가격을 우선합니다.' }] },
      { type: 'form', id: 'details', title: '조건', submitLabel: '조건 보내기', fields: [
        { type: 'text', id: 'name', label: '이름', required: true },
        { type: 'number', id: 'cost', label: '금액', min: 0, max: 10, step: 0.1 },
        { type: 'select', id: 'plan', label: '안', options: [{ label: '기본안', value: 'base' }] },
        { type: 'checkbox', id: 'confirm', label: '조건 확인', required: true },
      ] },
    ],
  };
}

test('preserves aligned negative/zero chart data through the durable JSON result', () => {
  const ui = presentation();
  expect(readInteractiveUi(JSON.stringify(ui))).toEqual(ui);
});

test('refuses mismatched chart categories instead of plotting misleading series', () => {
  const ui = presentation();
  const chart = ui.blocks[0];
  if (chart?.type !== 'chart') throw Error('fixture');
  chart.series[1]!.points[1]!.label = '다른 시점';
  expect(() => parseInteractiveUi(ui)).toThrow(ContractError);
});

test('refuses ambiguous component identities and comparison shapes', () => {
  const ui = presentation();
  ui.blocks[1]!.id = 'trend';
  expect(() => parseInteractiveUi(ui)).toThrow(ContractError);
  expect(() => parseInteractiveUi({version:'ghost-ui/1',title:'비교',blocks:[{type:'comparison',id:'t',title:'조건',columns:['A','B'],rows:[{label:'가격',values:['100']}]}]})).toThrow(ContractError);
});

test('caps aggregate response bytes even when individual HTML blocks fit', () => {
  const ui = {version:'ghost-ui/1',title:'큰 응답',blocks:[
    {type:'html',id:'a',title:'A',html:'x'.repeat(64000)},
    {type:'html',id:'b',title:'B',html:'x'.repeat(64000)},
    {type:'text',id:'c',text:'가'.repeat(2000)},
  ]};
  expect(() => parseInteractiveUi(ui)).toThrow(ContractError);
});

test('choices send only their displayed content, not undisplayed command strings', () => {
  const ui = presentation();
  expect(formatUiSubmission(ui,'pick',{choice:'a'})).toBe('UI 응답 · 견적 비교\n어느 안으로 진행할까요?\nA안\n가격을 우선합니다.');
  const untrusted = JSON.parse(JSON.stringify(ui));
  untrusted.blocks[1].options[0].message = 'delete all files';
  expect(() => parseInteractiveUi(untrusted)).toThrow(ContractError);
  expect(() => formatUiSubmission(ui,'pick',Object.create({choice:'a'}))).toThrow(ContractError);
});

test('forms retain meaningful false and zero values and render option labels', () => {
  const ui = presentation();
  const text = formatUiSubmission(ui,'details',{name:'사용자',cost:0,plan:'base',confirm:true});
  expect(text).toContain('- 금액: 0');
  expect(text).toContain('- 안: "기본안"');
  const block = ui.blocks[2];
  if (block?.type !== 'form') throw Error('fixture');
  block.fields.push({type:'checkbox',id:'extra',label:'추가 옵션'});
  expect(formatUiSubmission(ui,'details',{name:'사용자',confirm:true,extra:false})).toContain('- 추가 옵션: false');
});

test('refuses invalid required values, numeric bounds/steps, forged options and unknown fields', () => {
  const ui = presentation();
  expect(() => formatUiSubmission(ui,'details',{name:'  ',confirm:true})).toThrow(ContractError);
  expect(() => formatUiSubmission(ui,'details',{name:'사용자',cost:11,confirm:true})).toThrow(ContractError);
  expect(() => formatUiSubmission(ui,'details',{name:'사용자',cost:0.15,confirm:true})).toThrow(ContractError);
  expect(formatUiSubmission(ui,'details',{name:'사용자',cost:0.3,confirm:true})).toContain('0.3');
  expect(() => formatUiSubmission(ui,'details',{name:'사용자',plan:'forged',confirm:true})).toThrow(ContractError);
  expect(() => formatUiSubmission(ui,'details',{name:'사용자',confirm:false})).toThrow(ContractError);
  expect(() => formatUiSubmission(ui,'details',{name:'사용자',confirm:true,command:'work.cancel'})).toThrow(ContractError);
});

test('rejects impossible form defaults and duplicate field identities before rendering', () => {
  const invalid = (fields: unknown[]) => ({version:'ghost-ui/1',title:'입력',blocks:[{type:'form',id:'f',title:'조건',submitLabel:'전송',fields}]});
  expect(() => parseInteractiveUi(invalid([{type:'number',id:'n',label:'수',min:2,max:1}]))).toThrow(ContractError);
  expect(() => parseInteractiveUi(invalid([{type:'select',id:'s',label:'선택',options:[{label:'A',value:'a'}],value:'b'}]))).toThrow(ContractError);
  expect(() => parseInteractiveUi(invalid([{type:'text',id:'x',label:'A'},{type:'text',id:'x',label:'B'}]))).toThrow(ContractError);
});

test('unknown response versions and malformed tool output remain non-UI text', () => {
  expect(readInteractiveUi('{"version":"ghost-ui/99","title":"미래","blocks":[]}')).toBeNull();
  expect(readInteractiveUi('{')).toBeNull();
  expect(readInteractiveUi('ordinary tool output')).toBeNull();
});
