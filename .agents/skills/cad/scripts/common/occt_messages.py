"""Where OCCT's messages go: standard error, so a tool's standard output is its result alone."""

from __future__ import annotations

from OCP.Message import Message, Message_Gravity, Message_PrinterOStream


def occt_messages_to_stderr() -> None:
    """Send OCCT's messages to standard error, at the level they had, uncoloured. OCCT writes them to standard output,
    where a STEP reader's unresolved references would land before the JSON a caller parses, or among a worker's
    replies. Called again, it changes nothing."""
    messenger = Message.DefaultMessenger_s()
    streams = [printer for printer in messenger.Printers() if isinstance(printer, Message_PrinterOStream)]
    level = streams[0].GetTraceLevel() if streams else Message_Gravity.Message_Info
    messenger.RemovePrinters(Message_PrinterOStream.get_type_descriptor_s())
    printer = Message_PrinterOStream("cerr", False, level)
    printer.SetToColorize(False)
    messenger.AddPrinter(printer)
