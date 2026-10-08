import math, struct, zlib
from pathlib import Path
root=Path(__file__).resolve().parent.parent/'assets'
root.mkdir(exist_ok=True)
def png(size,color):
    def chunk(t,data):
        return struct.pack('>I',len(data))+t+data+struct.pack('>I',zlib.crc32(t+data)&0xffffffff)
    raw=bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            px=(x+.5)/size;py=(y+.5)/size
            inside=(px-.5)**2+(py-.5)**2<.43**2
            hand=(abs(px-.5)<.035 and .24<py<.53) or (abs(py-(.52+(px-.5)*.5))<.036 and .48<px<.72)
            raw.extend((*((255,255,255) if hand and inside else color),255 if inside else 0))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',size,size,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(bytes(raw)))+chunk(b'IEND',b'')
for name,color in [('tray-running',(136,116,219)),('tray-stopped',(146,146,142))]:
    (root/(name+'.png')).write_bytes(png(32,color))
images=[png(n,(136,116,219)) for n in (16,32,48,64,256)]
head=struct.pack('<HHH',0,1,len(images));offset=6+16*len(images);entries=b''
for n,data in zip((16,32,48,64,256),images):
    entries+=struct.pack('<BBBBHHII',n%256,n%256,0,0,1,32,len(data),offset);offset+=len(data)
(root/'icon.ico').write_bytes(head+entries+b''.join(images))
