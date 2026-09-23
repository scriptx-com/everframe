// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package android.media
import android.graphics.ImageFormat
import android.graphics.Rect
import java.nio.ByteBuffer

class VideoTestImage(private val w:Int,private val h:Int,private val readOnly:Boolean=false,private val crop:Rect=Rect(0,0,w,h)):Image() {
  override fun getFormat()=ImageFormat.YUV_420_888
  override fun getWidth()=w
  override fun getHeight()=h
  override fun getTimestamp()=0L
  override fun setTimestamp(timestamp:Long)=Unit
  override fun getCropRect()=crop
  override fun getPlanes():Array<Image.Plane> = Array(3){index -> object:Image.Plane(){
   private val bytes=ByteBuffer.allocate(if(index==0) w*h else w*h/4).let{if(readOnly)it.asReadOnlyBuffer() else it}
   override fun getBuffer()=bytes
   override fun getRowStride()=if(index==0)w else w/2
   override fun getPixelStride()=1
  }}
  override fun close()=Unit
 }
