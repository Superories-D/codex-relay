import {expect,it} from 'vitest';
import {discardQueueEdit,queueEditStatus,readQueueEdits,setQueueEdit} from '../src/renderer/queue-edits';
it('keeps the original base while typing and identifies remote conflicts without losing text',()=>{
 let edits=setQueueEdit({},'one','original','my first',1);
 edits=setQueueEdit(edits,'one','remote changed','my final',2);
 expect(edits.one).toEqual({base:'original',text:'my final',updatedAt:2});
 expect(queueEditStatus(edits.one,'remote changed')).toBe('conflict');
 expect(queueEditStatus(edits.one,'original')).toBe('editing');
 expect(queueEditStatus(edits.one,'my final')).toBe('saved');
 expect(queueEditStatus(edits.one,undefined)).toBe('removed');
 expect(readQueueEdits(JSON.stringify(edits))).toEqual(edits);
});
it('isolates message edits and bounds malformed local storage without treating drafts as messages',()=>{
 const edits=setQueueEdit(setQueueEdit({},'a','a','changed a'),'b','b','changed b');
 expect(discardQueueEdit(edits,'a').b.text).toBe('changed b');
 expect(edits.a.text).toBe('changed a');
 expect(readQueueEdits('{bad')).toEqual({});
 expect(readQueueEdits(JSON.stringify({bad:{base:'x',text:4,updatedAt:1},good:{base:'x',text:'y',updatedAt:1}}))).toEqual({good:{base:'x',text:'y',updatedAt:1}});
});
