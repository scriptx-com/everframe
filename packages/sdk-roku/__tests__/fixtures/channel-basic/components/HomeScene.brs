sub init()
    m.loader = CreateObject("roSGNode", "Loader")
    m.loader.observeField("content", "onContent")
    m.top.observeFieldScoped("focusedChild", "OnFocus")
end sub

function OnKeyEvent(key as string, press as boolean) as boolean ' keys
    return false
end function

sub OnTitle()
end sub

sub onContent()
end sub

sub OnFocus()
end sub

function refresh(params as object) as boolean
    return true
end function

sub notAnEntry()
end sub
