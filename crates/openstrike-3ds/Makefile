# Invoked by PocketJS in hosts/3ds; retain its runtime/recovery/capture rules.
APP := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))
include Makefile
P3D := $(APP)/../../vendor/pocketjs/engine/pocket3d/backends/citro3d
EXTRA := $(BUILD)/strike_bridge.o $(BUILD)/strike_gpu.o $(BUILD)/pocket3d.o $(BUILD)/textured.o $(BUILD)/color_shbin.o $(BUILD)/textured_shbin.o
OBJECTS += $(EXTRA)
CFLAGS += -I$(P3D) -I$(APP)

$(BUILD)/strike_bridge.o: $(APP)/bridge.c $(FLAGS_STAMP)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/strike_gpu.o: $(APP)/gpu.c $(BUILD)/color_shbin.h $(BUILD)/textured_shbin.h $(APP)/textured.h $(FLAGS_STAMP)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/pocket3d.o: $(P3D)/pocket3d.c $(P3D)/pocket3d.h $(FLAGS_STAMP)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/textured.o: $(APP)/textured.c $(APP)/textured.h $(FLAGS_STAMP)
	$(CC) $(CFLAGS) -c $< -o $@
$(BUILD)/%.shbin: $(P3D)/%.v.pica | $(BUILD)
	$(PICASSO) -o $@ $<
$(BUILD)/textured.shbin: $(APP)/textured.v.pica | $(BUILD)
	$(PICASSO) -o $@ $<
$(BUILD)/color_shbin.s $(BUILD)/color_shbin.h &: $(BUILD)/color.shbin
	cd $(BUILD) && $(BIN2S) -a 4 -H color_shbin.h color.shbin > color_shbin.s
$(BUILD)/textured_shbin.s $(BUILD)/textured_shbin.h &: $(BUILD)/textured.shbin
	cd $(BUILD) && $(BIN2S) -a 4 -H textured_shbin.h textured.shbin > textured_shbin.s
$(BUILD)/%_shbin.o: $(BUILD)/%_shbin.s
	$(CC) $(ARCH) -c $< -o $@

$(ELF): $(EXTRA) $(POCKETJS_CORE_LIB)
