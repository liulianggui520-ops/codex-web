import { DatabaseSync,backup } from 'node:sqlite';
import { chmod } from 'node:fs/promises';
const db=new DatabaseSync(process.argv[2]);try{await backup(db,process.argv[3]);await chmod(process.argv[3],0o600);}finally{db.close();}
console.log('Web state backup completed');
