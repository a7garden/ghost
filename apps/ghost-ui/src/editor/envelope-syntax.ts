// Copyright (c) 2026 a7garden. MIT; see LICENSE.
import type {MarkdownConfig} from '@lezer/markdown';

/** Keep the source envelope opaque to Markdown's setext-heading/live-preview rules. */
export const envelopeSyntax: MarkdownConfig = {
 defineNodes:[{name:'GhostEnvelope',block:true}],
 parseBlock:[{
  name:'GhostEnvelope',before:'HorizontalRule',
  parse(context,line){
   if(context.lineStart!==0 || line.text!=='---')return false;
   let end=line.text.length;
   while(context.nextLine()) {
    end=context.lineStart+line.text.length;
    if(line.text==='---'){context.nextLine();break;}
   }
   context.addElement(context.elt('GhostEnvelope',0,end));
   return true;
  },
 }],
};
