#include <stdio.h>

int calculate_total(int quantity, int price) {
    return quantity * price;
}

int main(void) {
    printf("REA Studio native demo: %d\n", calculate_total(3, 7));
    return 0;
}
