// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

package dev.everframe.capture.video
import java.nio.ByteBuffer
import android.media.VideoTestImage
import android.graphics.ImageFormat
import android.graphics.Rect
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.Assert.*
import org.junit.Test
@RunWith(RobolectricTestRunner::class) @Config(sdk=[29])
class Yuv420ConverterTest {
 @Test fun bt709LimitedReferencePrimariesAndNeutralColors() {
  val references = listOf(0xff000000.toInt() to intArrayOf(16,128,128),0xffffffff.toInt() to intArrayOf(235,128,128),0xffff0000.toInt() to intArrayOf(63,102,240),0xff00ff00.toInt() to intArrayOf(173,42,26),0xff0000ff.toInt() to intArrayOf(32,240,118))
  for ((rgb,reference) in references) {
   val planes=listOf(plane(8,1,17),plane(5,2,9),plane(7,2,21))
   assertTrue(Yuv420Converter.convert(IntArray(16){rgb},VideoSize(4,4),planes))
   for(i in 0..2) assertEquals(reference[i].toDouble(),(planes[i].buffer.get(planes[i].buffer.position()).toInt() and 255).toDouble(),1.0)
  }
 }
 @Test fun stridesAndIndependentPositionsPreservePaddingAndOrientation() {
  for(uvStride in 1..2) {
   val planes=listOf(plane(9,1,11),plane(7,uvStride,5),plane(8,uvStride,19))
   assertTrue(Yuv420Converter.convert(IntArray(16){if(it<8) 0xffffffff.toInt() else 0xff000000.toInt()},VideoSize(4,4),planes))
   assertEquals(235,planes[0].buffer.get(11).toInt() and 255)
   assertEquals(16,planes[0].buffer.get(11+3*9).toInt() and 255)
   assertEquals(77,planes[0].buffer.get(11+4).toInt())
   assertEquals(11,planes[0].buffer.position())
  }
 }
 @Test fun invalidPlaneRejectsBeforeAnyWrite() {
  val y=plane(4,1,0); val good=plane(2,1,0)
  for(bad in listOf(Yuv420Converter.Plane(ByteBuffer.allocate(1),2,1),Yuv420Converter.Plane(ByteBuffer.allocate(16).asReadOnlyBuffer(),2,1),Yuv420Converter.Plane(ByteBuffer.allocate(16),1,2))) {
   assertFalse(Yuv420Converter.convert(IntArray(16),VideoSize(4,4),listOf(y,good,bad)))
   assertEquals(77,y.buffer.get(0).toInt())
  }
 }
 @Test fun nullUndersizedReadOnlyAndOffsetCropImagesAreRejected() {
  assertNull(Yuv420Converter.planes(null,VideoSize(4,4)))
  for(image in listOf(VideoTestImage(2,4),VideoTestImage(4,4,readOnly=true),VideoTestImage(4,4,crop=Rect(2,0,4,4))))
   assertNull(Yuv420Converter.planes(image,VideoSize(4,4)))
  assertNotNull(Yuv420Converter.planes(VideoTestImage(4,4),VideoSize(4,4)))
 }
 private fun plane(row:Int,pixel:Int,start:Int)=Yuv420Converter.Plane(ByteBuffer.allocate(start+row*4).apply{repeat(capacity()){put(it,77)};position(start)},row,pixel)
}
