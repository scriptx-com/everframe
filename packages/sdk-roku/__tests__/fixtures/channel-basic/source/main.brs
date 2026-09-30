sub Main()
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)
    screen.CreateScene("HomeScene")
    screen.show()
end sub

function helper() as integer
    return 1
end function
